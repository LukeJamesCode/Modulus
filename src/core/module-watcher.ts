// Hot-reload watcher for the module loader, extracted from modules.ts.
//
// Two mechanisms, both per module root and per module folder:
//   1. fs.watch — kernel notifications (inotify / ReadDirectoryChangesW). Fast
//      but unreliable on some platforms: it can miss an in-place rewrite, and
//      on Windows it is recursive and often reports a null filename.
//   2. a 250ms mtime+size poll — the safety net that catches what fs.watch
//      misses. Debounced together with fs.watch so a real change reloads once.
//
// The watcher is pure plumbing: it detects changes and calls back into the
// loader (load this folder / unload this module). The loader owns the semantic
// decisions (what "changed" means, agent bookkeeping). State that belongs to
// watching — the timers, the per-folder closers, the in-flight reload set, and
// the suspend set — lives here so the loader file stays about loading.

import { existsSync, readdirSync, statSync, lstatSync, watch } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../util/log.js';

// Folders the watcher must never descend into. node_modules is the big one: a
// heavy module's setup runs `npm install --prefix <folder>`, which writes
// thousands of files — watching it turns one enable into a reload storm (and on
// a Pi, pegs inotify watch limits). uploads holds user-staged payloads (voice
// notes, etc.) that are data, not code. .git is never a module's own.
export const IGNORED_WATCH_DIRS = new Set(['node_modules', 'uploads', '.git']);

export interface ModuleWatcherDeps {
  log: Logger;
  roots: readonly string[];
  // The discovery filename whose presence makes a folder a loadable unit:
  // 'manifest.json' for modules, 'skill.json' for skills. Defaults to
  // manifest.json so the module loader needs no change.
  manifestFile?: string;
  // Read the loader's shutdown flag so a watcher callback that fires during
  // teardown becomes a no-op.
  isShuttingDown: () => boolean;
  // Load (or reload) the module rooted at this folder. The loader does the
  // manifest read, registration, and any onDidReload notification.
  loadModule: (folder: string) => Promise<void>;
  // Unload the named module (a watched folder disappeared).
  unloadModule: (name: string) => Promise<void>;
  // Fired after a watched reload completes. Startup loads directly and runs its
  // own notification, so this is only for watcher-driven reloads.
  onDidReload?: () => void | Promise<void>;
  // Is this folder already loaded? The root watcher uses it to skip an
  // already-loaded module (content changes are the per-folder watcher's job).
  isFolderLoaded: (folder: string) => boolean;
  // The module loaded from this folder, if any (used to unload on removal).
  nameForFolder: (folder: string) => string | undefined;
}

export interface ModuleWatcher {
  // Begin watching one module's folder (per-folder fs.watch tree + mtime poll).
  watchModuleFolder(name: string, folder: string): void;
  // Begin watching each module root for added/removed top-level folders.
  startRootWatchers(): void;
  // Pause/resume hot-reload for one module while its setup mutates the folder.
  suspend(name: string): void;
  resume(name: string): void;
  // Stop watching one module and drop any reload it had queued (called by the
  // loader's unload path).
  detach(name: string): void;
  // Per-module count of watcher-driven reloads since startup. A number that
  // climbs while nobody is editing files is the signature of a reload leak (a
  // module whose own setup churns its folder, an excluded dir slipping the
  // filter), which is exactly what this counter exists to make visible.
  reloadCounts(): Record<string, number>;
  // Tear everything down and wait for in-flight reloads to settle (shutdown).
  stop(): Promise<void>;
}

export function createModuleWatcher(deps: ModuleWatcherDeps): ModuleWatcher {
  const { log } = deps;
  const manifestFile = deps.manifestFile ?? 'manifest.json';
  const watchers: Array<() => void> = [];
  const moduleWatchers = new Map<string, () => void>();
  const reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const activeReloads = new Set<Promise<void>>();
  const reloadSuspended = new Set<string>();
  // Monotonic per-module count of reloads this watcher actually performed.
  const reloadCounts = new Map<string, number>();

  function scheduleReload(name: string, folder: string): void {
    if (deps.isShuttingDown() || reloadSuspended.has(name)) return;
    const existing = reloadTimers.get(name);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      reloadTimers.delete(name);
      const reloadTask = (async () => {
        if (deps.isShuttingDown()) return;
        if (!existsSync(folder) || !existsSync(join(folder, manifestFile))) {
          await deps.unloadModule(name);
          return;
        }
        log.info('module change detected, reloading', { mod: name });
        reloadCounts.set(name, (reloadCounts.get(name) ?? 0) + 1);
        await deps.loadModule(folder);
        if (!deps.isShuttingDown()) await deps.onDidReload?.();
      })();
      activeReloads.add(reloadTask);
      reloadTask
        .catch((e) => {
          log.warn('reload failed', {
            mod: name,
            error: e instanceof Error ? e.message : String(e),
          });
        })
        .finally(() => {
          activeReloads.delete(reloadTask);
        });
    }, 100);
    timer.unref?.();
    reloadTimers.set(name, timer);
  }

  function trackReloadTask(task: Promise<void>): void {
    activeReloads.add(task);
    task.then(
      () => activeReloads.delete(task),
      () => activeReloads.delete(task),
    );
  }

  function watchModuleFolder(name: string, folder: string): void {
    if (deps.isShuttingDown()) return;
    if (moduleWatchers.has(name)) return;
    try {
      const closes: Array<() => void> = [];
      const watchDir = (dir: string): void => {
        const w = watch(dir, { persistent: false }, (_event, file) => {
          // A null filename (common on Windows, where fs.watch is recursive)
          // tells us nothing about WHAT changed — blindly reloading on it makes
          // node_modules churn during setup trigger a reload. Defer to the
          // mtime poll below, which already excludes the ignored dirs and fires
          // within ~250ms on any real change.
          if (!file) return;
          // A change inside an ignored subdir (node_modules churn, a staged
          // upload) is not a code edit. On Windows the recursive watcher
          // reports the full relative path, so check every segment.
          if (
            String(file)
              .split(/[\\/]/)
              .some((s) => IGNORED_WATCH_DIRS.has(s))
          )
            return;
          scheduleReload(name, folder);
        });
        w.on('error', (e) => {
          if (deps.isShuttingDown()) return;
          log.warn('module folder watcher failed', {
            mod: name,
            folder: dir,
            error: e instanceof Error ? e.message : String(e),
          });
        });
        closes.push(() => w.close());
        let entries: string[] = [];
        try {
          entries = readdirSync(dir);
        } catch {
          return;
        }
        for (const entry of entries) {
          if (IGNORED_WATCH_DIRS.has(entry)) continue;
          const child = join(dir, entry);
          try {
            // lstatSync: never follow symlinks. Otherwise a symlink loop or
            // a link pointing outside the module folder would cause the
            // watcher to recurse forever / watch arbitrary directories.
            const st = lstatSync(child);
            if (st.isSymbolicLink()) continue;
            if (st.isDirectory()) watchDir(child);
          } catch {
            /* ignore vanished paths */
          }
        }
      };
      watchDir(folder);

      // Polling safety net: fs.watch is unreliable on some platforms /
      // filesystems (notably GitHub Actions' Linux runners, where an in-place
      // rewrite of an existing file occasionally doesn't deliver IN_MODIFY).
      // A 250ms mtime scan ensures we still notice a change within ~half a
      // second even when the kernel watcher misses the event. scheduleReload
      // already debounces, so double-triggers from fs.watch + polling collapse
      // into a single reload.
      // Fingerprint each file by mtime AND size. Coarse-mtime filesystems (and
      // CI runners) can rewrite a file's contents within the same mtime tick;
      // folding the byte size in catches a same-mtime length change that the
      // mtime alone would miss.
      const seenStamps = new Map<string, string>();
      const stampOf = (st: { mtimeMs: number; size: number }): string => `${st.mtimeMs}:${st.size}`;
      const snapshotMtimes = (dir: string): void => {
        let entries: string[] = [];
        try {
          entries = readdirSync(dir);
        } catch {
          return;
        }
        for (const entry of entries) {
          if (IGNORED_WATCH_DIRS.has(entry)) continue;
          const child = join(dir, entry);
          try {
            const st = lstatSync(child);
            if (st.isSymbolicLink()) continue;
            if (st.isDirectory()) {
              snapshotMtimes(child);
            } else if (st.isFile()) {
              seenStamps.set(child, stampOf(st));
            }
          } catch {
            /* ignore vanished paths */
          }
        }
      };
      snapshotMtimes(folder);
      const checkMtimes = (dir: string): boolean => {
        let entries: string[] = [];
        try {
          entries = readdirSync(dir);
        } catch {
          return false;
        }
        for (const entry of entries) {
          if (IGNORED_WATCH_DIRS.has(entry)) continue;
          const child = join(dir, entry);
          try {
            const st = lstatSync(child);
            if (st.isSymbolicLink()) continue;
            if (st.isDirectory()) {
              if (checkMtimes(child)) return true;
            } else if (st.isFile()) {
              const stamp = stampOf(st);
              const prev = seenStamps.get(child);
              if (prev === undefined || prev !== stamp) {
                seenStamps.set(child, stamp);
                return true;
              }
            }
          } catch {
            /* ignore vanished paths */
          }
        }
        return false;
      };
      const poll = setInterval(() => {
        if (deps.isShuttingDown()) return;
        if (checkMtimes(folder)) scheduleReload(name, folder);
      }, 250);
      poll.unref?.();
      closes.push(() => clearInterval(poll));

      moduleWatchers.set(name, () => {
        for (const close of closes) close();
      });
    } catch (e) {
      log.warn('failed to watch module folder', {
        mod: name,
        folder,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  function startRootWatchers(): void {
    for (const root of deps.roots) {
      try {
        const w = watch(root, { persistent: false }, (_event, file) => {
          if (deps.isShuttingDown()) return;
          if (!file) return;
          // We only react to top-level folder changes — nested file edits get
          // detected by the per-folder watcher.
          const seg = String(file).split(/[\\/]/);
          const top = seg[0];
          if (!top) return;
          // On Windows fs.watch is recursive, so a deep node_modules write
          // during setup arrives here as 'heavy-mod/node_modules/…'. Ignore
          // any change inside an excluded subdir, not just a top-level one.
          if (seg.some((s) => IGNORED_WATCH_DIRS.has(s))) return;
          // Paused while this module's setup mutates its folder — the setup
          // caller triggers a single explicit reload when it finishes.
          if (reloadSuspended.has(top)) return;
          const folder = join(root, top);
          const reloadTask = (async () => {
            if (deps.isShuttingDown()) return;
            if (!existsSync(folder) || !statSync(folder).isDirectory()) {
              const found = deps.nameForFolder(folder);
              if (found) {
                log.info('module folder removed', { mod: found });
                await deps.unloadModule(found);
              }
              return;
            }
            if (!existsSync(join(folder, manifestFile))) return;
            // Already-loaded folder: content changes are the per-module
            // watcher's job. The root watcher reacting here too would fire on
            // the folder's own mtime bump when a subdir like node_modules is
            // created inside — a false reload the segment filter can't see,
            // because the event names the module dir, not the nested path.
            // Only handle the genuinely-new folder (first appearance).
            if (deps.isFolderLoaded(folder)) return;
            log.info('module change detected, reloading', { folder: top });
            try {
              await deps.loadModule(folder);
              await deps.onDidReload?.();
            } catch (e) {
              log.warn('reload failed', {
                folder: top,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          })();
          trackReloadTask(reloadTask);
          reloadTask.catch(() => {});
        });
        w.on('error', (e) => {
          if (deps.isShuttingDown()) return;
          log.warn('modules root watcher failed', {
            root,
            error: e instanceof Error ? e.message : String(e),
          });
        });
        watchers.push(() => w.close());
      } catch (e) {
        log.warn('failed to watch modules root', {
          root,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  function detach(name: string): void {
    const close = moduleWatchers.get(name);
    if (close) {
      close();
      moduleWatchers.delete(name);
    }
    const timer = reloadTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      reloadTimers.delete(name);
    }
  }

  async function stop(): Promise<void> {
    for (const timer of reloadTimers.values()) clearTimeout(timer);
    reloadTimers.clear();
    for (const close of watchers) {
      try {
        close();
      } catch {
        /* ignore */
      }
    }
    watchers.length = 0;
    for (const close of moduleWatchers.values()) {
      try {
        close();
      } catch {
        /* ignore */
      }
    }
    moduleWatchers.clear();
    await Promise.allSettled([...activeReloads]);
  }

  return {
    watchModuleFolder,
    startRootWatchers,
    suspend: (name: string) => {
      reloadSuspended.add(name);
      // Drop any reload already queued before the pause so it can't fire
      // mid-setup once the debounce elapses.
      const timer = reloadTimers.get(name);
      if (timer) {
        clearTimeout(timer);
        reloadTimers.delete(name);
      }
    },
    resume: (name: string) => {
      reloadSuspended.delete(name);
    },
    detach,
    reloadCounts: () => Object.fromEntries(reloadCounts),
    stop,
  };
}

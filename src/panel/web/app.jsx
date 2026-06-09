/* global React, ReactDOM, window */
// Root app. Holds the shared agent/health state (polled from /api/state),
// decides between the first-run wizard and the main hub, and owns the agent
// start/stop/restart actions (which POST to /api/agent/* — the server shells
// out to `modulus start --detach` / `modulus stop`). Theme is a simple
// localStorage-backed light/dark toggle; dark is the default.
const { useState, useEffect, useCallback, useRef } = React;

// Chat and Voice Hub are folded into the Dashboard (a Chat/Voice toggle there),
// so they have no standalone nav entries.
const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'home' },
  { id: 'agents', label: 'Agents', icon: 'spark' },
  { id: 'extensions', label: 'Modules', icon: 'plug' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
  { id: 'system', label: 'System', icon: 'pulse' },
];

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('modulus_theme') || 'dark';
    } catch (e) {
      return 'dark';
    }
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('modulus_theme', theme);
    } catch (e) {
      /* ignore */
    }
  }, [theme]);
  return [theme, setTheme];
}

function useDensity() {
  const [density, setDensity] = useState(() => {
    try {
      return localStorage.getItem('modulus_density') || 'balanced';
    } catch (e) {
      return 'balanced';
    }
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-density', density);
    try {
      localStorage.setItem('modulus_density', density);
    } catch (e) {
      /* ignore */
    }
  }, [density]);
  return [density, setDensity];
}

function App() {
  const [theme, setTheme] = useTheme();
  const [density, setDensity] = useDensity();
  const [state, setState] = useState(null);
  const [offline, setOffline] = useState(false);
  const [loadError, setLoadError] = useState(null); // reachable but rejected (e.g. 401)
  const [route, setRoute] = useState('dashboard');
  const [busy, setBusy] = useState(null); // agent action in flight: start|stop|restart|null
  const [forcedView, setForcedView] = useState(null); // override configured-based view
  const pollRef = useRef(null);

  const refresh = useCallback(async () => {
    const r = await window.api.get('/api/state');
    if (r.ok) {
      setState(r.data);
      setOffline(false);
      setLoadError(null);
    } else if (r.offline) {
      setOffline(true);
      setLoadError(null);
    } else {
      // Reachable, but the server refused the request (401 bad/missing token,
      // 500, etc). Without this branch the app would spin on the boot screen
      // forever, since neither `state` nor `offline` ever gets set.
      setOffline(false);
      setLoadError({ status: r.status || 0, error: r.error || 'request failed' });
    }
    return r.ok ? r.data : null;
  }, []);

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, 4000);
    return () => clearInterval(pollRef.current);
  }, [refresh]);

  const agentAction = useCallback(
    async (action) => {
      setBusy(action);
      await window.api.post(`/api/agent/${action}`);
      await refresh();
      // Poll a couple more times — the daemon takes a beat to come up/down.
      setTimeout(refresh, 1200);
      setTimeout(() => {
        refresh();
        setBusy(null);
      }, 2600);
    },
    [refresh],
  );

  const setProactive = useCallback(
    async (on) => {
      setState((s) => ({ ...s, proactive: on }));
      await window.api.post('/api/agent/proactive', { on });
      refresh();
    },
    [refresh],
  );

  // ---- access denied / server error ----
  if (!state && loadError) {
    const is401 = loadError.status === 401;
    const forgetToken = () => {
      try {
        localStorage.removeItem('modulus_token');
      } catch (e) {
        /* ignore */
      }
      location.reload();
    };
    return (
      <div className="boot">
        <span className="boot-mark" style={{ background: 'var(--err)' }}>
          !
        </span>
        <span className="boot-text">
          {is401
            ? 'Access token missing or incorrect.'
            : `Couldn’t load the panel (HTTP ${loadError.status || '?'}).`}
        </span>
        {is401 && (
          <span
            style={{ fontSize: 13, color: 'var(--text-3)', maxWidth: 360, textAlign: 'center' }}
          >
            Open the link printed by <code>modulus start</code> on startup — it includes the
            required <code>?token=…</code>.
          </span>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          {is401 && (
            <window.Button variant="subtle" onClick={forgetToken}>
              Forget saved token
            </window.Button>
          )}
          <window.Button variant="subtle" icon="refresh" onClick={refresh}>
            Retry
          </window.Button>
        </div>
      </div>
    );
  }

  // ---- loading / boot ----
  if (!state && !offline) {
    return (
      <div className="boot">
        <span className="boot-mark">m</span>
        <span className="boot-text">Loading Modulus…</span>
      </div>
    );
  }

  if (!state && offline) {
    return (
      <div className="boot">
        <span className="boot-mark" style={{ background: 'var(--err)' }}>
          !
        </span>
        <span className="boot-text">Can’t reach the Modulus panel server.</span>
        <window.Button variant="subtle" icon="refresh" onClick={refresh}>
          Retry
        </window.Button>
      </div>
    );
  }

  const configured = !!state.configured;
  const view = forcedView || (configured ? 'hub' : 'wizard');
  const agentStatus =
    busy === 'stop'
      ? 'stopping'
      : busy
        ? 'starting'
        : state.agent && state.agent.running
          ? 'running'
          : 'stopped';

  if (view === 'wizard') {
    return (
      <window.Wizard
        suggestedTier={state.suggestedTier}
        ramGb={state.ramGb}
        onExit={() => setForcedView('hub')}
        onFinish={async () => {
          setForcedView('hub');
          setRoute('dashboard');
          await refresh();
          agentAction('start');
        }}
      />
    );
  }

  const health = state.health || {};
  const models = state.models || {};
  const enabledExts = (state.extensions && state.extensions.enabledNames) || [];
  const needsSetup = (state.extensions && state.extensions.needsSetup) || [];
  const panelEnabled = enabledExts.indexOf('modulus-frontend') !== -1;
  const visibleExtCount = Math.max(
    0,
    ((state.extensions && state.extensions.enabled) || 0) - (panelEnabled ? 1 : 0),
  );
  const voiceEnabled = enabledExts.indexOf('modulus-voice') !== -1;

  return (
    <div className="app-shell">
      <Sidebar
        route={route}
        setRoute={setRoute}
        agentStatus={agentStatus}
        onStart={() => agentAction('start')}
        onStop={() => agentAction('stop')}
        busy={busy}
        extCount={visibleExtCount}
        enabledExts={enabledExts}
        needsSetup={needsSetup}
        onOpenExtensions={() => setRoute('extensions')}
        theme={theme}
        setTheme={setTheme}
        density={density}
        setDensity={setDensity}
      />

      <main className="main-panel">
        <Topbar state={state} setRoute={setRoute} offline={offline} agentStatus={agentStatus} />
        {offline && <OfflineBar onRetry={refresh} />}
        {state.cfgError && <ConfigErrorBar message={state.cfgError} />}
        <div className="content-shell">
          {route === 'dashboard' && (
            <window.DashboardTab
              state={state}
              agent={agentStatus}
              busy={busy}
              onStart={() => agentAction('start')}
              onStop={() => agentAction('stop')}
              onRestart={() => agentAction('restart')}
              proactive={state.proactive}
              onProactive={setProactive}
              health={{ telegram: !!health.telegram, ollama: !!health.ollama }}
              models={models}
              lastError={state.lastError || null}
              scheduler={state.scheduler}
              activity={state.activity}
              extensions={state.extensions}
              tier={state.tier}
              allowlistCount={state.allowlistCount}
              voiceEnabled={voiceEnabled}
            />
          )}
          {route === 'agents' && <window.AgentsTab state={state} />}
          {route === 'extensions' && <window.ExtensionsTab />}
          {route === 'settings' && (
            <window.SettingsTab onReRunWizard={() => setForcedView('wizard')} onSaved={refresh} />
          )}
          {route === 'system' && (
            <window.SystemTab state={state} onReset={() => setForcedView('wizard')} />
          )}
          {route === 'docs' && <window.DocsTab />}
        </div>
      </main>
    </div>
  );
}

function nowLabel() {
  try {
    return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}

function Topbar({ state, setRoute, offline, agentStatus }) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [clock, setClock] = useState(() => nowLabel());
  const dropdownRef = useRef(null);

  // Localized wall-clock in the top bar (Stitch). Tick once a minute.
  useEffect(() => {
    const id = setInterval(() => setClock(nowLabel()), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    // We only need to load them to check if there are notifications.
    const loadNotifs = async () => {
      try {
        const t = await window.api.get('/api/agents/tasks');
        if (t.ok && t.data && t.data.tasks) setTasks(t.data.tasks);
      } catch (e) {
        // ignore
      }
    };
    loadNotifs();
    const interval = setInterval(loadNotifs, 5000);
    return () => clearInterval(interval);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    } else {
      document.removeEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  const needsSetup = (state && state.extensions && state.extensions.needsSetup) || [];
  const activeTasks = tasks
    .filter((t) => t.status === 'running' || t.status === 'error')
    .slice(0, 5);

  const notifications = [
    ...needsSetup.map((ext) => ({
      id: `setup-${ext.name}`,
      icon: 'plug',
      title: 'Extension Needs Setup',
      desc: `${ext.name.replace(/^modulus-/, '')} requires configuration.`,
      action: () => setRoute('extensions'),
    })),
    ...activeTasks.map((t) => ({
      id: `task-${t.id}`,
      icon: t.status === 'error' ? 'alert-triangle' : 'loader',
      tone: t.status === 'error' ? 'err' : 'accent',
      title: t.status === 'error' ? 'Task Error' : 'Active Run',
      desc: t.agentName || `Task #${t.id}`,
      action: () => setRoute('agents'),
    })),
  ];

  const toggleOpen = () => setOpen(!open);

  return (
    <div className="topbar">
      <div className="search-bar">
        <window.Icon name="search" size={16} />
        <span>Search or Cmd+K</span>
        <span className="search-kbd">⌘K</span>
      </div>
      <div className="topbar-actions">
        <span className="conn-clock" title="Local time">
          <window.Icon name="clock" size={14} /> {clock}
        </span>
        <span className={`conn-pill${offline ? ' off' : ''}`} title="Panel connection">
          <window.StatusDot state={offline ? 'error' : 'running'} size={7} pulse={!offline} />
          {offline ? 'Offline' : 'Connected'}
        </span>
        <button className="dash-btn green" onClick={() => setRoute('agents')}>
          <window.Icon name="play" size={14} /> New Run
        </button>
        <div className="icon-action" style={{ position: 'relative' }} ref={dropdownRef}>
          <div
            onClick={toggleOpen}
            style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}
          >
            <window.Icon name="bell" size={18} />
            {notifications.length > 0 && <div className="badge">{notifications.length}</div>}
          </div>
          {open && (
            <div
              style={{
                position: 'absolute',
                top: 36,
                right: -10,
                width: 320,
                background: 'var(--glass-bg-strong)',
                backdropFilter: 'blur(40px)',
                WebkitBackdropFilter: 'blur(40px)',
                border: '1px solid var(--glass-border)',
                borderTop: '1px solid var(--border-2)',
                borderRadius: 'var(--radius)',
                boxShadow: 'var(--shadow-pop)',
                zIndex: 100,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--border)',
                  fontWeight: 600,
                  fontSize: 13,
                  color: 'var(--text)',
                }}
              >
                Notifications
              </div>
              <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                {notifications.length === 0 ? (
                  <div
                    style={{
                      padding: '20px',
                      textAlign: 'center',
                      color: 'var(--text-3)',
                      fontSize: 13,
                    }}
                  >
                    No new notifications.
                  </div>
                ) : (
                  notifications.map((n) => (
                    <div
                      key={n.id}
                      onClick={() => {
                        setOpen(false);
                        n.action();
                      }}
                      style={{
                        padding: '12px 14px',
                        borderBottom: '1px solid var(--border)',
                        cursor: 'pointer',
                        display: 'flex',
                        gap: 12,
                        alignItems: 'flex-start',
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <div
                        style={{
                          color: `var(--${n.tone || 'text-2'})`,
                          flex: 'none',
                          marginTop: 2,
                        }}
                      >
                        <window.Icon name={n.icon} size={16} />
                      </div>
                      <div>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: 13,
                            color: 'var(--text)',
                            marginBottom: 2,
                          }}
                        >
                          {n.title}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{n.desc}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
        <div className="icon-action" onClick={() => setRoute('docs')} style={{ cursor: 'pointer' }}>
          <window.Icon name="help-circle" size={18} />
        </div>
        <div
          className="icon-action"
          onClick={() => setRoute('settings')}
          style={{ cursor: 'pointer' }}
        >
          <window.Icon name="settings" size={18} />
        </div>
      </div>
    </div>
  );
}

function OfflineBar({ onRetry }) {
  return (
    <div
      style={{
        background: 'color-mix(in oklab, var(--err) 12%, var(--surface))',
        borderBottom: '1px solid color-mix(in oklab, var(--err) 30%, transparent)',
        padding: '10px 22px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 13.5,
      }}
    >
      <window.Icon name="alert" size={16} style={{ color: 'var(--err)' }} />
      <span style={{ flex: 1, color: 'var(--text-2)' }}>
        Lost connection to the panel server — showing the last known state.
      </span>
      <window.Button size="sm" variant="subtle" icon="refresh" onClick={onRetry}>
        Retry
      </window.Button>
    </div>
  );
}

function ConfigErrorBar({ message }) {
  return (
    <div
      style={{
        background: 'color-mix(in oklab, var(--warn) 14%, var(--surface))',
        borderBottom: '1px solid color-mix(in oklab, var(--warn) 34%, transparent)',
        padding: '10px 22px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 13.5,
      }}
    >
      <window.Icon name="alert" size={16} style={{ color: 'var(--warn)' }} />
      <span style={{ flex: 1, color: 'var(--text-2)' }}>Config problem: {message}</span>
    </div>
  );
}

/* ---------------- global status pill + start/stop ---------------- */
function GlobalStatus({ agentStatus, onStart, onStop, busy }) {
  const running = agentStatus === 'running';
  const stopping = agentStatus === 'stopping';
  const starting = agentStatus === 'starting' || (!!busy && !stopping);
  const transitioning = starting || stopping;
  const labels = {
    running: 'Running',
    stopped: 'Stopped',
    starting: 'Starting',
    stopping: 'Stopping',
    error: 'Error',
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 12px',
          borderRadius: 99,
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          flex: 1,
          minWidth: 0,
        }}
      >
        <window.StatusDot
          state={transitioning ? 'starting' : agentStatus}
          size={9}
          pulse={running}
        />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
          {stopping ? 'Stopping' : starting ? 'Starting' : labels[agentStatus]}
        </span>
      </div>
      <window.Button
        size="sm"
        variant={running || stopping ? 'default' : 'primary'}
        icon={running || stopping ? 'stop' : 'power'}
        onClick={running ? onStop : onStart}
        disabled={transitioning}
        style={
          running || stopping
            ? {
                color: 'var(--err)',
                borderColor: 'color-mix(in oklab, var(--err) 38%, transparent)',
              }
            : {}
        }
      >
        {stopping ? 'Stopping' : running ? 'Stop' : starting ? '…' : 'Start'}
      </window.Button>
    </div>
  );
}

function Wordmark() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <svg
        width="34"
        height="34"
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ flex: 'none', filter: 'drop-shadow(0 0 8px rgba(0, 229, 91, 0.45))' }}
      >
        <path d="M 6.7 25 L 6.7 75 L 50 100 L 50 75 L 28.3 62.5 L 28.3 37.5 Z" fill="#22c55e" />
        <path d="M 28.3 37.5 L 28.3 62.5 L 50 75 L 50 50 Z" fill="#14532d" />
        <path d="M 50 0 L 50 25 L 28.3 37.5 L 6.7 25 Z" fill="#4ade80" />
        <path d="M 93.3 50 L 93.3 75 L 50 100 L 50 75 L 71.7 62.5 L 71.7 50 Z" fill="#16a34a" />
        <path d="M 71.7 50 L 71.7 62.5 L 50 50 L 50 37.5 Z" fill="#22c55e" />
        <path d="M 93.3 50 L 71.7 50 L 50 37.5 L 71.7 37.5 Z" fill="#4ade80" />
        <path d="M 28.3 62.5 L 50 75 L 71.7 62.5 L 50 50 Z" fill="#34d399" />
        <path d="M 50 25 L 71.7 37.5 L 71.7 50 L 50 37.5 Z" fill="#14532d" />
      </svg>
      <div style={{ lineHeight: 1.05, marginTop: 2 }}>
        <div
          className="display"
          style={{ fontSize: 20, fontWeight: 800, letterSpacing: 0, color: 'var(--text)' }}
        >
          MODULUS
        </div>
        <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 700, letterSpacing: 0.5 }}>
          CONTROL CENTER
        </div>
      </div>
    </div>
  );
}

/* ---------------- sidebar ---------------- */
function Sidebar({
  route,
  setRoute,
  agentStatus,
  onStart,
  onStop,
  busy,
  extCount,
  enabledExts,
  needsSetup,
  onOpenExtensions,
  theme,
  setTheme,
  density,
  setDensity,
}) {
  const items = NAV.filter(
    (n) => !n.requiresExt || (enabledExts || []).indexOf(n.requiresExt) !== -1,
  );
  const setupList = needsSetup || [];
  const setupCount = setupList.length;
  // Dismiss persists per setup fingerprint — re-shows if the unfinished list
  // changes, but stays quiet while the same extensions are pending.
  const setupKey = setupList
    .map((s) => s.name)
    .sort()
    .join(',');
  const [dismissedKey, setDismissedKey] = useState(() => {
    try {
      return localStorage.getItem('modulus_ext_setup_dismissed') || '';
    } catch (e) {
      return '';
    }
  });
  const showPopup = setupCount > 0 && route !== 'extensions' && dismissedKey !== setupKey;
  const dismissPopup = () => {
    try {
      localStorage.setItem('modulus_ext_setup_dismissed', setupKey);
    } catch (e) {
      /* ignore */
    }
    setDismissedKey(setupKey);
  };
  return (
    <aside
      style={{
        width: 236,
        flex: 'none',
        background: 'var(--glass-bg-strong)',
        backdropFilter: 'blur(var(--glass-blur))',
        WebkitBackdropFilter: 'blur(var(--glass-blur))',
        borderRight: '1px solid var(--glass-border)',
        display: 'flex',
        flexDirection: 'column',
        padding: '14px 12px',
        zIndex: 40,
      }}
      className="sidebar"
    >
      <div
        style={{
          padding: '2px 6px 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Wordmark />
        <window.IconButton
          name={theme === 'dark' ? 'sun' : 'moon'}
          label={theme === 'dark' ? 'Light theme' : 'Dark theme'}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        />
      </div>
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {items.map((n) => {
          const on = route === n.id;
          return (
            <button
              key={n.id}
              onClick={() => setRoute(n.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 10px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid',
                borderColor: on ? 'var(--accent-ring)' : 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                background: on ? 'var(--accent-soft)' : 'transparent',
                color: on ? 'var(--accent-strong)' : 'var(--text-2)',
                boxShadow: on ? 'var(--bloom)' : 'none',
                fontWeight: on ? 600 : 500,
                fontSize: 14,
                transition: 'background .12s, color .12s, border-color .12s',
              }}
              onMouseEnter={(e) => {
                if (!on) e.currentTarget.style.background = 'var(--surface-2)';
              }}
              onMouseLeave={(e) => {
                if (!on) e.currentTarget.style.background = 'transparent';
              }}
            >
              <window.Icon
                name={n.icon}
                size={18}
                style={{ color: on ? 'var(--accent-strong)' : 'var(--text-3)' }}
              />
              <span style={{ flex: 1 }}>{n.label}</span>
              {n.id === 'extensions' && setupCount > 0 && (
                <span
                  title={`${setupCount} extension${setupCount === 1 ? '' : 's'} need setup: ${setupList
                    .map((s) => s.name.replace(/^modulus-/, ''))
                    .join(', ')}`}
                  style={{
                    minWidth: 18,
                    height: 18,
                    padding: '0 6px',
                    borderRadius: 99,
                    background: 'var(--warn)',
                    color: 'var(--on-accent, #fff)',
                    fontSize: 11,
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    lineHeight: 1,
                  }}
                >
                  {setupCount}
                </span>
              )}
              {n.id === 'extensions' && setupCount === 0 && extCount > 0 && (
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 700,
                    color: 'var(--text-3)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {extCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      {showPopup && (
        <SetupPopup
          items={setupList}
          onOpen={() => {
            dismissPopup();
            onOpenExtensions && onOpenExtensions();
          }}
          onDismiss={dismissPopup}
        />
      )}
      <div style={{ flex: 1 }} />

      <div
        style={{
          padding: '0 12px 12px',
          fontSize: '10px',
          color: 'var(--text-3)',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          margin: '0 10px',
        }}
      >
        <span>CONTROL CENTER v1.2.3</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span className="dot green" style={{ width: '6px', height: '6px' }}></span> All systems
          operational
        </span>
      </div>
    </aside>
  );
}

function SetupPopup({ items, onOpen, onDismiss }) {
  const pretty = (name) =>
    name
      .replace(/^modulus-/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <div
      role="status"
      style={{
        marginTop: 10,
        padding: 12,
        background: 'color-mix(in oklab, var(--warn) 12%, var(--surface))',
        border: '1px solid color-mix(in oklab, var(--warn) 40%, transparent)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <window.Icon name="alert" size={15} style={{ color: 'var(--warn)' }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
          Finish extension setup
        </span>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{
            marginLeft: 'auto',
            background: 'none',
            border: 'none',
            color: 'var(--text-3)',
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
            padding: 2,
          }}
        >
          ×
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.45 }}>
        {items.length === 1 ? (
          <>
            <strong>{pretty(items[0].name)}</strong> still needs{' '}
            {items[0].status === 'needs_auth' ? 'a connection' : 'required settings'}.
          </>
        ) : (
          <>
            {items.length} extensions still need setup:{' '}
            <strong>{items.map((s) => pretty(s.name)).join(', ')}</strong>.
          </>
        )}
      </div>
      <button
        onClick={onOpen}
        style={{
          alignSelf: 'flex-start',
          background: 'var(--warn)',
          color: 'var(--on-accent, #fff)',
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          padding: '6px 10px',
          fontSize: 12.5,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Open Extensions →
      </button>
    </div>
  );
}

Object.assign(window, { App });

ReactDOM.createRoot(document.getElementById('root')).render(<App />);

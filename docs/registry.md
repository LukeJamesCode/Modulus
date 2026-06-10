# The module registry

The marketplace (panel **Modules → Browse marketplace**, and
`modulus mod install <name>`) installs from a curated registry: a single
`index.json` listing each published module with a pinned, hash-verified tarball.
This document is the contract for the **`modulus-registry`** repo that hosts it.

Modulus only ever _reads_ the registry. The consumer side is built:

- `src/core/registry.ts` — fetch + parse `index.json`.
- `src/core/installer.ts` — download → **sha256 verify** → strict **ustar**
  extract → stage → commit.
- Default index URL: `https://raw.githubusercontent.com/<owner>/modulus-registry/main/index.json`
  (constant `DEFAULT_REGISTRY_URL` in `registry.ts`). Override with
  `MODULUS_REGISTRY_URL` for a self-hosted fork.

What's left to stand up is the **`modulus-registry` GitHub repo + its CI** — an
outward-facing step (a new public repo) for the maintainer.

## `index.json` schema

An array (or `{ "modules": [ … ] }`) of entries. The shape is
`RegistryIndexEntry` in `src/core/installer.ts`; `parseRegistryEntry` validates
each one strictly — a malformed entry fails the whole index loudly, because a bad
entry in a curated index is a publishing bug, not a module to silently drop.

```jsonc
{
  "modules": [
    {
      "name": "modulus-todo", //  ^[a-z0-9][a-z0-9_-]{1,63}$, must equal manifest.name
      "version": "1.2.0", //  exact semver major.minor.patch
      "displayName": "To-Do", //  optional, for the card title
      "description": "Lists and reminders.", //  optional
      "tarball": "https://github.com/<owner>/modulus-registry/releases/download/modulus-todo-1.2.0/modulus-todo-1.2.0.tgz",
      "sha256": "a1b2…64 hex chars…", //  of the exact tarball bytes
      "minCoreVersion": "1.0.0", //  optional; install refuses on older cores
      "permissions": {
        //  optional; drives the consent screen
        "network": ["api.example.com"],
        "subprocess": ["ffmpeg"],
        "filesystem": ["~/Music"],
      },
      "docs": "https://…", //  optional link
    },
  ],
}
```

`tarball` must be `https://`. `permissions` is what the user consents to; keep it
honest and minimal — it's exactly what the panel and CLI display before granting.

## Tarball requirements (the strict extractor)

`installer.ts`'s extractor is deliberately strict, so the CI must pack to match:

- **Plain `ustar`** only. The extractor rejects pax/gnu long-name entries, so
  keep every path ≤ 100 bytes (hence short module names and shallow layouts).
- `manifest.json` at the archive root (`./manifest.json`) or under a single
  `./<name>/` prefix — both are accepted. `manifest.name` **must equal** the
  index entry's `name`.
- No absolute paths, no `..` traversal, no symlinks. Size caps:
  ~50 MB compressed, ~200 MB unpacked.

Pack a module folder with GNU tar in ustar format:

```sh
tar --format=ustar -czf "modulus-todo-1.2.0.tgz" -C modules modulus-todo
sha256sum "modulus-todo-1.2.0.tgz"
```

> Avoid `npm pack` — it emits pax headers and a `package/` prefix the strict
> extractor rejects.

## CI sketch (in the `modulus-registry` repo)

On a tag/release, for each module folder: pack → sha256 → attach the `.tgz` as a
release asset → regenerate `index.json` → commit it to `main`.

```yaml
name: publish
on:
  push:
    tags: ['*']
jobs:
  pack:
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@v4
      - name: Pack each module, collect entries
        run: |
          mkdir -p dist
          for dir in modules/*/; do
            name=$(jq -r .name "$dir/manifest.json")
            version=$(jq -r .version "$dir/manifest.json")
            tgz="dist/${name}-${version}.tgz"
            tar --format=ustar -czf "$tgz" -C modules "$name"
            sha=$(sha256sum "$tgz" | cut -d' ' -f1)
            url="https://github.com/${GITHUB_REPOSITORY}/releases/download/${name}-${version}/${name}-${version}.tgz"
            jq -n --arg n "$name" --arg v "$version" --arg t "$url" --arg s "$sha" \
              --argjson p "$(jq '.permissions // {}' "$dir/manifest.json")" \
              '{name:$n, version:$v, tarball:$t, sha256:$s, permissions:$p}' >> entries.ndjson
          done
          jq -s '{modules: .}' entries.ndjson > index.json
      - uses: softprops/action-gh-release@v2
        with: { files: dist/*.tgz }
      # then commit index.json back to main (e.g. stefanzweifel/git-auto-commit-action)
```

Once the repo exists and `DEFAULT_REGISTRY_URL`'s `<owner>` points at it, the
marketplace and `modulus mod install` light up with whatever Phase 5 publishes.

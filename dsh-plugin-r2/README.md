# dsh-genoffice-sidebar

DSH side panel unified ecosystem plugin (client + host dual-face cordis
plugin): a tabbed sidebar container (工作区 | 终端 | GenOffice | 文件), a
GenOffice file browser with embedded read-only preview, a host-backed
directory browser, and an xterm terminal over a host pty WebSocket.

## Architecture

```text
DSH sidebar slot ← dsh-genoffice-sidebar (TabsRoot)
    ├── sidebar.workspaces（官方保留）
    ├── sidebar.settings（官方保留）
    └── sidebar.tabs.terminal|genoffice|files（可插拔子槽位）
genoffice relay (:8787) ← /api/dir + CORS loopback（web/server.mjs）
host pty ws: /api/pty.ws ← node-pty (host half)
```

- Client half (`src/client/`): registers `sidebar` (the official ui-sidebar
  is patched out), declares the ecosystem tab slots, renders the panels.
- Host half (`src/index.ts`): registers the `/api/pty.ws` upgrade route;
  spawns `node-pty` directly (the DSH `ctx.pty` service is line-oriented
  for model tools and does not stream to an interactive xterm).

## Build

```sh
npm install          # dev deps: tsdown + typescript (+ ws/node-pty symlinks)
npm run typecheck
npm run build        # lib/index.js (host) + lib/client.js (browser)
```

## Install into the DSH web profile

```sh
# 1. link the package into the profile
cd ~/.dsh/profiles/web
pnpm add file:/ABS/PATH/dsh-plugin

# 2. the profile patch layer (~/.dsh/profiles/web/cordis.patch.yml) must
#    contain:
#    - id: ui-sidebar
#      disabled: true
#    - id: directory-picker
#      disabled: true
#    - insert:
#        - id: genoffice-sidebar-r2
#          name: 'dsh-genoffice-sidebar-r2'
#        - id: directory-picker-browse
#          name: '@deepseek-ai/dsh-host-directory-picker-browse'
#    (the row package name must match the package directory under the
#    profile's node_modules; a renamed copy requires the copy's package
#    name AND the client bundle id to match — build with
#    DSH_PLUGIN_ID=<name> npm run build)

# 3. start the GUI
dsh web
```

Why `directory-picker` is swapped: the files tab browses through
`host.listDirectory`, which requires the `browse` directory-picker
capability; the auto row resolves to `native` on this host (no listing).
The official `-browse` backend is the in-app browser dialog.

### Iterating on the host half without restarting `dsh web`

Node caches the imported module, so the host half cannot hot-reload. Dev
trick used here: keep a renamed copy (`dsh-plugin-r2`, package name
`dsh-genoffice-sidebar-r2`) linked as the profile's
`node_modules/dsh-genoffice-sidebar-r2`, build with
`DSH_PLUGIN_ID=dsh-genoffice-sidebar-r2`, sync `lib/`, and flip the row in
the patch — the fresh specifier forces a fresh import. The client half
needs only a page refresh (the bundle is served with
`cache-control: no-cache`). The stale row's entry leaks in the loader; the
client `apply` carries a duplicate-instance guard (the older bundle stays
inert when the slot is already registered).

## Uninstall / rollback

1. Empty `~/.dsh/profiles/web/cordis.patch.yml` — keep the trailing `[]`
   line (a comments-only file does not parse as a list).
2. Remove the `dsh-genoffice-sidebar` dependency from the profile
   `package.json` (`pnpm remove`).
3. Restart `dsh web`: the official `ui-sidebar` registrant takes over
   untouched (verified: a fallback boot shows the official sidebar).

## Version-pinning note

Developed against the DSH snapshot `c15895f` (Private DSH snapshot
20260806T160212Z). Client APIs (slots, layout owner props, the module
table) and the pty/ws seams are tied to that snapshot's shape; re-verify
when upgrading DSH.

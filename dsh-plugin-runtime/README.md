# dsh-genoffice-sidebar

DSH side panel unified ecosystem plugin (client + host dual-face cordis plugin).

## Status

Task 1 smoke stage: proves the DSH profile plugin load chain (ASM-001) and
iframe embedding (ASM-002). The `apply` in `src/client/index.ts` only logs
and renders a corner badge — the real TabsRoot replaces it in Task 9.

## Build

```sh
npm install        # dev deps: tsdown + typescript
npm run typecheck  # tsc against the DSH source type graph
npm run build      # lib/index.js (host half) + lib/client.js (browser half)
```

## Install into the DSH web profile

```sh
# link the package into the profile
cd ~/.dsh/profiles/web
pnpm add file:/ABS/PATH/dsh-plugin    # or edit package.json dependencies + pnpm install

# add the plugin row to the profile patch layer
# ~/.dsh/profiles/web/cordis.patch.yml:
# - insert:
#     - id: genoffice-sidebar
#       name: 'dsh-genoffice-sidebar'

# restart dsh web (or rely on the live profile patch HMR, then refresh)
```

## Uninstall / fallback

Comment out or remove the `genoffice-sidebar` insert row in
`cordis.patch.yml` and remove the dependency: the official `ui-sidebar`
registrant takes over again untouched.

## Version-pinning note

The DSH snapshot this was developed against: `c15895f` (Private DSH snapshot
20260806T160212Z). Client APIs (slots, layout owner props, module table) are
tied to that snapshot's shape; re-verify when upgrading DSH.

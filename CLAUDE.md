# CLAUDE.md

Guidance for AI agents and human contributors working in this repo.

## Syncing the official upstream (fork rule, mandatory)

This checkout is the DSH fork (`origin` = `Nothing1024/dsh-genoffice-engine`).
`upstream` (`genspark-ai/genoffice`) is fetch-only: merge it in, never push to
it. Merge upstream tag by tag into a sync branch, then push that branch to
`origin`.

Every upstream merge must review the editor agent tools it brings in before
the DSH plugin (`../plugin`) may expose them:

1. List what changed since the last synced upstream commit
   (`git merge-base HEAD upstream/main`) in the tool definition files:
   `apps/{docs,pdf,markdown,html}/src/renderer/ai/tools.ts` (`AGENT_TOOLS`),
   `apps/sheets/src/renderer/ai/tools.ts` (`WORKBOOK_TOOLS`) and
   `apps/slides/src/renderer/ai/slides-skill.ts`. Cover added, removed or
   renamed tools, and input schema changes on tools the plugin already
   exposes.
2. For each changed tool, answer three questions:
   - Compatible: does it run in the web build? Check that it needs no
     Electron-only IPC (a `web-bridge.ts` stub), and whether it needs
     App-held state the control executor must pass in (like the docs
     comments and header/footer accessors).
   - Needs adaptation: what must change in the control executor,
     `web-bridge.ts` or the relay (`web/server.mjs`) to make it work?
   - Worth exposing: does a DSH agent need it, does it duplicate an existing
     plugin tool, and does it reach the network?
3. Record the decision per tool in the plugin's
   `packages/tab-genoffice/src/host/capability.ts` (`CAPABILITY`, with
   evidence). A tool without an entry is not registered, and an unreviewed
   tool stays unregistered. A schema change on an exposed tool needs a
   review too.
4. Before calling the sync done, run the plugin's
   `node scripts/e2e-plugin-alignment.mjs --all` against the merged engine.
   Put the per-tool decisions in the sync commit message or PR description.

## Theming rules (mandatory)

The suite supports light / dark / system UI themes. The switching mechanism is a
`data-theme` attribute on `<html>` plus CSS custom properties defined once in
`packages/ui/src/tokens.css` (light defaults in `:root`, overrides in
`[data-theme='dark']`, and a `prefers-color-scheme` media-query fallback for
system mode).

1. **UI chrome colors must use semantic tokens.** Never write raw `#hex` /
   `rgb()` in renderer CSS rules or chrome-related inline styles — reference
   `var(--surface)`, `var(--text)`, `var(--hover)`, etc. from
   `packages/ui/src/tokens.css`. Raw values are allowed only on custom-property
   definition lines (`--x: #...;` — token, accent, or app-scoped variable
   definitions). CI enforces this for new/changed renderer CSS lines
   (`tools/check-theme-colors.mjs`).
2. **Every new token gets both values.** Adding a token means adding it to all
   three blocks in `tokens.css` (light, dark, system-dark fallback).
3. **Accent colors stay per-app.** Each app defines `--accent` /
   `--accent-dark` / `--accent-soft` (and its dark-adjusted values) in its own
   `styles.css`. Shared rules reference `var(--accent)` and inherit the app's
   brand color.
4. **Document content is never re-authored by the theme.** Page surfaces, cell
   fills, slide content, PDF page bitmaps, export/print stylesheets, chart
   palettes, highlight color maps, stamps, and WordArt presets are document
   data: they stay hardcoded, must not reference chrome tokens, and every
   save/export/print path must produce identical output in both themes. A
   Word/Excel-style _dark page_ (Sheets via Univer's `darkMode`, Docs via
   `apps/docs/src/renderer/editor/dark-page.ts`) is a display-time remap only:
   the authored color stays the real declaration, the remapped twin lives in
   a screen-only `--dk-*` / `.page-dark` layer, and print/export never see it.
5. **Canvas-drawn UI affordances go through a constants table.** Konva/canvas
   editing chrome (selection frames, guides, handles) reads from the app's
   canvas color table (e.g. `canvas-colors.ts`) keyed by the current theme —
   no inline hex in draw calls.

## Build gotchas

- App main-process code (`apps/*/src/main`) is compiled into the **shell**
  build. After changing it, rebuild the shell or the change silently does not
  run.
- In dev mode, preload changes require a rebuild — a stale preload leaves the
  renderer blank.
- Workspace packages listed in an app's `dependencies` must also be added to
  the `externalizeDepsPlugin` `exclude` list, or the packaged app crashes on
  launch.
- `useI18n()`'s `t` is not referentially stable; never put it in a hook
  dependency array. Store the key and translate at render time.

## UI strings (i18n)

- Large dictionaries are sharded per locale: `i18n/strings-<domain>.ts` is a
  thin aggregator over `i18n/<domain>/<lang>.ts` (one file per language, `zh`
  defines the key set). Add a new key to `zh.ts` and to every sibling shard;
  the `satisfies Record<keyof typeof zh, string>` on each shard turns a
  missing or extra key into a type error. Never grow the aggregator back into
  a single 19-locale object.

# Official merge resolution

Merge in `/tmp/genoffice-official-sync-engine` (`--no-commit`). Ours: fork `247e3f5c`. Official: `MERGE_HEAD` `de139a06`. Session-safety that was not in committed ours was taken from `/tmp/genoffice-official-sync-baseline/dirty-overlay/`.

No `git checkout --ours/--theirs` of a whole file. No commit. Original engine tree was not written.

## Conflicted files (16)

| file | ours-kept | official-kept | reason |
| --- | --- | --- | --- |
| `.gitignore` | fork ignore entries (control/session artifacts, local scratch) | official ignore entries | Keep both ignore sets so neither side's generated/local paths are tracked. |
| `README.md` | fork control-session / local workflow notes | official product/docs wording | Union both README sections rather than dropping one side's documentation. |
| `apps/markdown/src/renderer/ai/markdown-skill.ts` | fork skill/cache/session pieces that still apply | official “other non-GFM” wording (no duplicate math line) | Official phrasing is the intended authoring rule; fork extras stay where they do not conflict with that rule. |
| `apps/markdown/src/renderer/components/Ribbon.tsx` | `hideAi` / control hide-AI wrap | `data-ribbon-body=""` | Ribbon must hide AI in control mode and remain targetable via the official body attribute. |
| `apps/slides/src/main/page-spec.ts` | fork re-export-only layout (`export * from '../shared/page-spec'`) | — (algorithm lives in shared) | Main process file is a compatibility re-export; official algorithm fixes were ported into `apps/slides/src/shared/page-spec.ts`. |
| `apps/slides/tests/page-spec.test.ts` | fork import path `../src/shared/page-spec` | official `HeuristicMetrics` / new cases | Tests must hit the shared module and cover official metric-driven growth. |
| `apps/slides/tests/scratch-block.test.ts` | fork `clearSkillStateCache` + `addElement` spies | official `apply_ops` / `applyTxn` | Skill now applies via txn; cache-clear and both spies are required for isolation and assertions. |
| `apps/sheets/src/renderer/edit-journal.ts` | fork `isCellValue` (string \| number \| boolean) | official `plainCellValue`, `escapeCssLeadingDigit` / `unescapeCssLeadingDigit` | Boolean cells stay typed through `isCellValue`; official CSS-family + plain-value helpers are required for style/save fidelity. |
| `apps/sheets/src/renderer/save-actions.ts` | fork `SavePayloadBundle` / `buildSavePayload` assembler | official `getScrollAnchor` viewAtSave, `#ERROR!` filter, `collectFormulaCachedValues`, sparklines, `restoreWriteBack`, CSV banner/`csvContent` | Assembler stays the control-mode export path; `handleSave` must use official view/CSV/write-back behavior. |
| `apps/sheets/src/renderer/ExcelShell.tsx` | fork `control-mode` class + `{!CONTROL_MODE && (` AI/chat hide | official collapse header + `data-ribbon-body=""` | Control sessions hide AI chrome; official ribbon/header markup stays. |
| `apps/sheets/src/renderer/App.tsx` | fork `SavePayloadBundle` wiring + session-safety (`controlRef`, `CONTROL_PATH`, `setReadiness` loading/ready) | official UI/tools/save path (boolean cells, sparklines, view/CSV consumers) | Official sheet features plus dirty-overlay readiness without duplicating comments/hf stores (none at App). |
| `apps/docs/src/renderer/App.tsx` | dirty-overlay session-safety (`controlRef`, `applyControlReady`, pending flush, hide-AI) + thin getters `getTrack`/`getComments`/`getHf`/`getFrozen` | official UI/tools (`buildDocBytes`, edit queue, HF/comments access objects) | Union official editor/AI surface with control readiness; accessors read existing App stores, not a second comments/hf state. |
| `apps/markdown/src/renderer/App.tsx` | dirty-overlay `controlRef`, `setReadiness` loading/ready/error, SHA-256 revision, `CONTROL_PATH` empty-result error, `bumpRevision` on every `markDirty`, `data-readiness` | official markdown UI/tools (`uiOp`, edit queue) | Control plane needs load/revision/error; official editor features stay. Revision must bump on later edits, not only the first dirty flip. |
| `apps/pdf/src/renderer/App.tsx` | dirty-overlay `CONTROL_PATH`, `applyControlReady` on ready/password/load-fail/empty, pending flush | official PDF UI/OCR/`PdfAppDeps` | Official viewer/tools plus control readiness without clobbering new official code. |
| `apps/slides/src/renderer/ai/slides-skill.ts` | fork `land_pages` / `executeLandPages` / skill-state cache / `hiddenMediaTools` | official `OP_GROUPS` / `opGuide*` / `parsePageSpec` | Keep land_pages as the fork landing path; drop obsolete hand-build tools; take official op vocabulary. |
| `apps/slides/src/renderer/ai/AiPanel.tsx` | fork `landGeneratedPages` call shape (pageMarkers) | official skill/panel wiring | Panel must call the current `window.slidesApi.landGeneratedPages` signature and keep official panel changes. |

Related non-conflicted edit (algorithm port, not a fourth-side overwrite):

- `apps/slides/src/shared/page-spec.ts`: official `growTextBoxesToContent` + `fontMetrics` + render types; kept fork async `imageDims`.

## Overlay files copied

From `/tmp/genoffice-official-sync-baseline/dirty-overlay/` (official did not conflict these, or 3-way was required so official-only new code was not clobbered):

- `apps/docs/src/renderer/control.ts` (then `executeTool` already passed `getTrack` / `getFrozen` / `getComments` / `getHf`; App supplies thin getters)
- `apps/markdown/src/renderer/control.ts`
- `apps/pdf/src/renderer/control.ts`
- `apps/sheets/src/renderer/control.ts`
- `apps/slides/src/renderer/control.ts`
- `apps/slides/src/renderer/App.tsx` (3-way: official auto-merge + dirty session-safety)
- `web/server.mjs`
- `web/write-atomic.mjs` (dirty copy; 100ms slack removed)
- `web/write-atomic.test.mjs`
- `web/e2e-control-session.mjs`
- `test-setup/localstorage.ts`
- `apps/docs/tests/protect-dialog.test.ts`
- `apps/sheets/tests/xlsx-save-edits.test.ts`
- `packages/electron-utils/tests/remote-image.test.ts`
- `apps/markdown/src/renderer/web-bridge.ts`
- `fixtures/generated/simple.pdf`
- `apps/docs/vitest.config.ts` (added `setupFiles` → `test-setup/localstorage.ts`; kept official aliases)
- `apps/markdown/vitest.config.ts` (same setupFiles union)
- `apps/slides/vitest.config.ts` (same setupFiles union; kept official `custgeom` alias)

Not copied over official-only new files. `web/e2e-official-sync.mjs` was left untracked (not in the dirty overlay set).


## Session-safety overlay rule

App.tsx files were not copied from dirty-overlay. Official UI and official `aiCommentsAccess` / `aiHfAccess` remain. Only hooks were ported: `initControlMode`, `setReadiness`, owner/revision/`exportRevision`, `pendingReady`, load-failure no-blank.

Docs `control.ts` context/tool paths use the same App-held accessors (`getTrack` / `getComments` / `getHf`, optional frozen). Context freezes selection like official docs-skill and calls `buildDocContext(editor, frozen.scope, comments.list(), hf.read())`. No second comments store.

Related non-conflicted edit (web build boundary, needed for Task 2 markdown loop):

- `packages/ai-provider/src/codex-app-server.browser.ts`: stub so web bundles keep `streamForProvider` from the package root without pulling Node `child_process`.
- `apps/markdown/vite.web.config.ts`: resolve the Node Codex module to that stub. Other apps get the same treatment in the browser-provider task.

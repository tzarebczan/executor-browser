# Executor Browser — Fable 5 design + implementation

You are Claude Fable 5 running a **design + implementation** session (not review-only).

## Skills
Load and follow the **frontend-design** skill before writing UI. Brief already pins tokens — respect them; spend boldness on the signal rail + calm ops density, not purple AI chrome.

## Code root
`C:\Users\thoma\Documents\executor-browser` (cwd should already be here)

## Read first
1. `design/BRIEF.md` — goals, Capture, IA, locked tokens
2. `design/playground/` — current static mock (raise fidelity if thin)
3. Live panel: `extension/sidebar.html`, `sidebar.css`, `sidebar.js`
4. Capture impl: `extension/background.js` → `capturePreview` (do not change semantics)

## Capture (for UI copy only)
Local-only JPEG of agent/active tab for the human preview. Does **not** send to Executor. Agents use reverse `screenshot` / `snapshot` tools separately. Label it "Local preview" / similar so operators aren't confused.

## Deliverables (in order)
1. **Playground** — ship-quality static mock in `design/playground/` (~360px panel, Home | Connect | Tabs | Agents, signal rail, connected / needs-key / offline). Sharp, clean, professional, easy.
2. **Extension port** — implement into `extension/sidebar.{html,css,js}`:
   - Preserve chrome.runtime message API and critical IDs (`btnCapture`, connect fields, tab radios, etc.) — restyle first, restructure carefully.
   - Keep auto-connect, reverse (path B) default, Advanced companion/native below fold.
   - Capture button + auto soft-capture still work.
3. Bump version in `extension/manifest.json` (minor UX ship).
4. Append a short **QA checklist** to `C:\Users\thoma\Documents\tbd\coord\tracks\executor-browser-ui.md` under Done/Todo.

## Non-goals
No reverse-bridge protocol changes. No Executor web redesign. No new backend features.

## Done when
Playground looks production-ready; live extension panel matches it; existing connect/reverse/capture flows still work; track file updated.

Write files. Prefer editing existing structure over rewrite-from-scratch of sidebar.js logic.

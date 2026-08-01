# Executor Browser — COMPLETE UI/UX redesign (Fable 5)

You are Claude **Fable 5**. This is a **full design + implementation** job, not a reskin and not a token swap.

The founder rejected the last pass as incomplete (“doesn’t look like a complete overhaul”). Deliver something that **feels like a new product surface** while keeping wiring alive.

## Skills
Load **frontend-design** and follow it. Take one real aesthetic risk you can justify. Avoid generic “AI purple dashboard” and avoid looking like a lightly recolored v0.5 panel.

## Code root
`C:\Users\thoma\Documents\executor-browser`

Work **in this tree** (design/ is already tracked — do **not** create a worktree, do **not** `cp -r` design). Edit files in place.

## Product
Chrome MV3 **side panel** (~360px) that pairs this browser to Executor so remote agents can drive Chrome via reverse tools. Audience: operators. Must feel sharp, calm, dense, professional.

## Capture (behavior — improve reliability, keep semantics)
- Local JPEG preview for the human only (`capturePreview` in `background.js`).
- Does **not** send pixels to Executor; agents use reverse `screenshot`/`snapshot`.
- Fix “view is invisible” if still broken: un-minimize window, activate tab, retry with focus.
- UI must label Capture as **local preview**.

## What “complete overhaul” means (mandatory)

1. **Playground first** (`design/playground/`): high-fidelity static mock that is the design source of truth. All primary states:
   - Connected + reverse live
   - Needs API key
   - Executor offline / auth failed
   - Empty agent tabs
   - Capture error + capture success
2. **Visual system**: distinctive type, color, spacing, hierarchy, motion restraint. Signature element (signal rail or better — one memorable device). Not a 1:1 clone of the current HTML with new CSS vars.
3. **IA**: Home / Connect / Tabs / Agents still make sense; you may reorganize within panels for clarity.
4. **Copy**: operator-plain; no essays; empty/error states tell you what to do next.
5. **Extension port**: rewrite `extension/sidebar.html` + `sidebar.css` to match playground quality; keep `sidebar.js` behavior via **stable element IDs** and message API:
   - Critical IDs: `btnCapture`, `btnConnect`, `btnRefresh`, `executorUrl`, `executorApiKey`, `connectForm`, `connectMatrix`, `connectMatrixOpt`, `agentMatrixCore`, `agentMatrixDrive`, `agentPrompt`, `btnCopyAgentPrompt`, `btnOpenTab`, `btnOpenTabHome`, `tabList`, `activityList`, `publicEndpoint`, `healthUrl`, `mcpUrl`, `groupTitle`, drive chips `data-drive`, mode radios `name="mode"`, Advanced panel fields, setup banner IDs.
6. **Preserve**: auto-connect, reverse path B default, Advanced companion/native below fold.
7. Bump `extension/manifest.json` version (0.6.x → 0.7.0 if full redesign).
8. Update `design/BRIEF.md` if tokens/IA change.
9. Update track file: `C:\Users\thoma\Documents\tbd\coord\tracks\executor-browser-ui.md` with QA checklist + status.

## Non-goals
- No reverse-bridge protocol changes
- No Executor web product redesign
- No new backend services

## Quality bar
When finished, a founder should open the side panel and say “this is a new UI,” not “they changed the colors.” Playground and live extension should match closely.

## Done
- Files written and consistent
- Capture friendly errors for invisible tab
- Track file updated
- Short summary of design decisions at end of your reply

**Start now. Write code. No long planning monologue.**

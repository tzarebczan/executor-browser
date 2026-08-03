# Executor Browser — UI brief (v0.7 "Patch bay")

**Track:** `executor-browser-ui`
**Model:** Claude Fable 5 (design + implement)
**Playground:** `design/playground/` — imports `extension/sidebar.css` directly, so the mock and the shipped panel share one stylesheet and cannot drift.

## Product

Chrome MV3 side panel (~360px) that pairs **this browser** to **Executor** (lab/self-host) so remote agents can use reverse browser tools. Audience: technical operators who already know Tailscale/API keys.

## Design concept

**"Patch bay, night shift."** The panel is the operator's bench instrument that patches a remote brain (Executor) into local hands (Chrome). One continuous chassis face — full-bleed hairline-ruled modules, not floating cards. Warm carbon, never navy; amber means *needs the operator*; phosphor green is reserved strictly for *live*.

**Signature:** the **uplink spine** on Home — a vertical circuit trace UPLINK → BRIDGE → TABS. Segments light as each dependency comes alive and the energised segments carry a slow flowing current (static under `prefers-reduced-motion`). The chain order is real topology: each link depends on the one above.

## Capture (behavior)

**Capture** is a local JPEG preview of the agent tab, for the human only. It is **never sent to Executor** — agents take their own `screenshot`/`snapshot` via the reverse bridge.

1. Prefer active tab in the **Executor** tab group; else active tab in a normal window.
2. Activates that tab (focuses the window only on manual Capture).
3. `chrome.tabs.captureVisibleTab` → JPEG (~quality 60) shown in the Home monitor.
4. On "view is invisible": un-minimize window → activate tab → retry with focus → one more retry after a longer paint settle. Friendly error if still hidden.

UI frames the preview as a **viewfinder** (corner registration marks) with a "Stays local" stamp.

## Design system (v0.7 tokens — locked)

| Token | Value | Role |
|-------|--------|------|
| `--carbon` | `#141110` | chassis / page |
| `--bay` | `#1b1713` | module surfaces |
| `--raise` | `#262019` | inputs / raised keys |
| `--line` | `#3a3226` | borders |
| `--rule` | `#262019` | hairline module rules |
| `--ink` | `#ede4d3` | primary text |
| `--dim` | `#9c9180` | secondary text |
| `--faint` | `#6f665a` | tertiary / stamps |
| `--amber` | `#f0a63e` | action + attention (warn shares amber) |
| `--live` | `#62d392` | healthy / live only |
| `--fault` | `#e8705a` | error |
| `--led-off` | `#4d4437` | de-energised LED / trace |

**Type:**
- UI: `"Spline Sans", "Segoe UI", system-ui, sans-serif`
- Labels/data/wordmark: `"Spline Sans Mono", ui-monospace, Consolas, monospace` — uppercase micro-labels with 0.1em+ tracking carry the instrument voice.

**Shape & motion:** 2–4px radii, flat surfaces, no glow/scanlines. Motion budget: trace flow on the live spine, soft pulse on "checking" — nothing else.

## Information architecture

```
┌ Mast: patch glyph · EXECUTOR/BROWSER · status readout · ↻ ┐
│ [setup strip: checklist + quick actions when not ready]    │
│ HOME · CONNECT(ED) · TABS n · AGENTS   ← mono key row      │
│                                                            │
│ HOME:    uplink spine → monitor (local preview) → activity │
│ CONNECT: banner · ledger checks · form (collapses when ok) │
│          · browser-drive module · Advanced below fold      │
│ TABS:    agent group list · mode radios                    │
│ AGENTS:  core/drive ledgers · copyable agent prompt        │
└────────────────────────────────────────────────────────────┘
```

## Implementation constraints

- MV3 side panel HTML/CSS/JS, no framework.
- `sidebar.js` message API and element IDs are the contract — the HTML serves them (`btnCapture`, `btnConnect`, `executorUrl`, `connectMatrix`, `agentPrompt`, drive chips `data-drive`, mode radios `name="mode"`, …). Restyle/restructure freely around those hooks.
- Preserve auto-connect + reverse bridge only (no native host / companion).
- Version bump on ship (v0.7.0).

## Deliverables

1. `design/playground/index.html` — high-fidelity mock, all six states (connected/capture-ok, needs key, offline, auth failed, empty tabs, capture error).
2. `extension/sidebar.{html,css}` rewritten to match; `sidebar.js` behavior intact.
3. QA checklist in `coord/tracks/executor-browser-ui.md`.

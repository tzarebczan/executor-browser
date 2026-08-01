# Executor Browser — UI overhaul brief

**Track:** `executor-browser-ui`  
**Model:** Claude Fable 5 (design + implement)  
**Playground:** `design/playground/` (empty canvas — not wired to extension yet)

## Product

Chrome side panel that pairs **this browser** to **Executor** (lab/self-host) so remote agents can use reverse browser tools. Audience: technical operators and agents who already know Tailscale/API keys.

## Capture (current behavior)

**Capture** is local-only UI preview. It does **not** send pixels to Executor by itself.

1. Prefer active tab in the **Executor** tab group; else active tab in a normal window.
2. Activates that tab (and focuses the window if user clicked Capture).
3. `chrome.tabs.captureVisibleTab` → JPEG (~quality 60).
4. Shows result in the Home preview stage.

Auto-capture also runs softly after open/boot (no window focus). Fails on `chrome://` / extension pages.  
Agent screenshots use a **separate** reverse-bridge path (`screenshot` tool), not this button.

## Goals

1. **One-glance status** — connected / reverse live / agent tabs (no word salad).
2. **Connect is the product** — API key path first; Advanced below fold.
3. **Preview earns its space** — Capture labeled as local preview; empty states actionable.
4. **Agents path** — short status matrix + copy prompt; no essay.
5. **Sharp, clean, professional** — ops/instrument calm, not “AI purple dashboard.”

## Non-goals

- Full CDP companion UX as default (Advanced only).
- Redesign Executor web product (extension side panel only).
- New features beyond clarity (except health/detail strings already planned).

## Information architecture (target)

```
┌ Header: brand · status pill · refresh ──────────────┐
│                                                      │
│  [ Home | Connect · | Tabs n | Agents ]               │
│                                                      │
│  HOME: preview + 3 signal cells + activity           │
│  CONNECT: banner · matrix · form (collapsed if ok)   │
│           · drive mode chips · Advanced details      │
│  TABS: group list · mode radios                      │
│  AGENTS: status matrix · prompt                      │
└──────────────────────────────────────────────────────┘
~360px wide · dark · dense but readable
```

## Design system (locked for playground)

| Token | Value | Role |
|-------|--------|------|
| `--void` | `#0c0e12` | page |
| `--panel` | `#141820` | cards |
| `--lift` | `#1c222d` | elevated |
| `--line` | `#2a3140` | borders |
| `--ink` | `#e8ecf1` | primary text |
| `--dim` | `#8b95a8` | secondary |
| `--signal` | `#5b9fd4` | primary action / focus |
| `--live` | `#3dcf8e` | healthy |
| `--warn` | `#e0b44a` | caution |
| `--fault` | `#e8726a` | error |

**Type:**  
- UI: `"IBM Plex Sans", system-ui, sans-serif`  
- Data: `"IBM Plex Mono", ui-monospace, monospace`

**Signature:** Status as a single **signal rail** (LED + mono latency) — not three competing cards fighting the preview.

## Implementation constraints

- MV3 side panel HTML/CSS/JS (no React unless justified).
- Keep existing `sidebar.js` message API / IDs where possible; restyle first, restructure second.
- Preserve auto-connect, reverse bridge, path B default, Advanced companion/native.
- Version bump when shipping to extension/.

## Deliverables

1. `design/playground/index.html` — high-fidelity static mock (all states).
2. Port into `extension/sidebar.{html,css,js}` with behavior intact.
3. Short QA checklist in track file.

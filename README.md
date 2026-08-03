# Executor Browser

Chrome MV3 **side panel** that pairs this browser with **Executor** over Tailscale so remote agents can drive tabs via a reverse bridge.

## What it does

1. **Connect** — Executor base URL + personal API key (Bearer MCP).
2. **Reverse bridge** — extension long-polls Executor for browser tool jobs and posts results.
3. **Agent tab group** — only tabs in the extension-owned “Executor” group are controllable.
4. **Local preview** — Capture is a JPEG for the human UI only (not sent to Executor).

Agents use **`tools.browser.user.desktop.*`** (snapshot, navigate, click, type, screenshot, tabs). There is no companion process and no native messaging host in this product path.

## Install

1. `chrome://extensions` → Developer mode → Load unpacked → select `extension/`.
2. Open the side panel (extension icon).
3. Connect with your lab Executor URL + API key.
4. Open an agent tab, then use agents against the browser tools.

## Architecture (short)

```text
Agent  →  tools.browser.user.desktop  →  Executor browser-bridge
                                              │
Extension ←── long-poll jobs / POST results ──┘
    │
    └── chrome.tabs / scripting (Executor group only)
```

Details: `docs/ARCHITECTURE.md`, `docs/BRIDGE-MODES.md`.

## Develop

```bash
npm test   # node --test (extension unit + security canaries)
```

Reload the unpacked extension after edits.

## Version

See `extension/manifest.json` (currently **0.8.0** — reverse-only surface).

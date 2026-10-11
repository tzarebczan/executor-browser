# Executor Browser

Chrome MV3 **side panel** that pairs this browser with **Executor** over Tailscale so remote agents can drive tabs via a reverse bridge.

## What it does

1. **Find Executor** on this machine or the tailnet (a bare hostname is enough) and connect with an API key.
2. **Show one status line.** Connected, looking, or what to fix.
3. **Developer tools**, off, for a 30 minute window, or always on.
4. Agents drive this browser through Executor. The panel does not preview pages or manage a tab list.

Agents use **`tools.browser.user.<connection>.*`** for typed tab, navigation, inspection, interaction, file, screenshot, console, network, and CDP operations. The first unlabeled Chrome stays `desktop`. A second browser (Brave, Edge, another Chrome profile) gets its own connection name so agents can tell them apart — call `status` to list live local browsers. There is no companion process or native messaging host: Advanced mode uses `chrome.debugger` in the extension and the existing reverse bridge over Executor/Tailscale.

## Install

1. `chrome://extensions` → Developer mode → Load unpacked → select `extension/`.
2. Open the side panel (extension icon).
3. Connect with your lab Executor URL + API key.
4. Open an agent tab, then use agents against the browser tools.

## Architecture (short)

```text
Agent  →  tools.browser.user.<connection>  →  Executor browser-bridge
                                              │
Extension ←── long-poll jobs / POST results ──┘
    │
    └── chrome.tabs / scripting / debugger (scoped by user settings)
```

Details: `docs/ARCHITECTURE.md`, `docs/BRIDGE-MODES.md`.

## Develop

```bash
npm test   # node --test (extension unit + security canaries)
```

Reload the unpacked extension after edits.

## Version

`extension/manifest.json` is the only place the version is written. The side
panel footer reads it from the manifest at runtime; this file deliberately does
not repeat the number, because the copy that used to live here had already
fallen two releases behind.

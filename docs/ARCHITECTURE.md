# Architecture

| Piece | Role |
|-------|------|
| **Extension (MV3)** | One side panel: status, Tailscale find, API key, developer tools |
| **Executor browser channel** | Session / long-poll jobs / results on the v2 host. Address `tools.browser.user.<connection>` |

## Connect

1. Find fills a bare tailnet name or a full URL. A saved address that is only offline is left alone.
2. The API key is checked with `GET {base}/api/browser-bridge/sessions` (Bearer). That lists sessions and does not open one. The v2 local server refuses this extension's origin on `/mcp`, so the key is not checked there. Self-host answers `GET /health` even when this channel is absent.
3. On success the extension opens `POST /api/browser-bridge/session` and long-polls `GET …/session/:id/jobs`, posting `POST …/result`.
4. The first unlabeled Chrome stays `desktop`. Another browser gets its own `tools.browser.user.<name>`.

No local Node companion and no `chrome.runtime.connectNative` host. The panel does not preview pages or list tabs. The v2 local server listens on `127.0.0.1:4312`. Find tries that address before the other local ports.

## Developer tools

`cdpMode` is `off`, `session` (a 30 minute window), or `always`. An older install that only stored `advancedMode: true` is read as `session`. Always-on does not need that window. The extension still limits tools to its own tab group unless access is set to full.

## Controllable tabs

Automation is restricted to the **tab group created and owned by the extension** (default title “Executor”). Foreign tabs and personal active tabs are never tool targets.

## Screenshot

The `screenshot` tool returns the image to Executor as a job result. There is no side-panel preview.

## Security notes

- No `externally_connectable` / no web-page messaging into the extension.
- The extension enforces the scope it advertises: its own tab group, the host allowlist, and developer tools off, for a window, or always on.
- Navigate/open only allow `http:` / `https:` URLs.

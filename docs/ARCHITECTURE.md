# Architecture

| Piece | Role |
|-------|------|
| **Extension (MV3)** | One side panel: status, Tailscale find, API key, developer tools |
| **Executor browser channel** | Session / long-poll jobs / results on the v2 host. Address `tools.browser.user.<connection>` |

## Connect

1. Find fills a bare tailnet name or a full URL. A saved address that is only offline is left alone.
2. The API key is checked with `MCP initialize` against `{base}/mcp` (Bearer). Executor v2 self-host answers `GET /health`; that host is Executor even before this channel is mounted.
3. On success the extension opens `POST /api/browser-bridge/session` and long-polls `GET …/session/:id/jobs`, posting `POST …/result`.
4. The first unlabeled Chrome stays `desktop`. Another browser gets its own `tools.browser.user.<name>`.

No local Node companion and no `chrome.runtime.connectNative` host. The panel does not preview pages or list tabs.

## Developer tools

`cdpMode` is `off`, `session` (a 30 minute window), or `always`. An older install that only stored `advancedMode: true` is read as `session`. Always-on does not need that window. The extension still limits tools to its own tab group unless access is set to full.

## Controllable tabs

Automation is restricted to the **tab group created and owned by the extension** (default title “Executor”). Foreign tabs and personal active tabs are never tool targets.

## Screenshot

The `screenshot` tool returns the image to Executor as a job result. There is no side-panel preview.

## Security notes

- No `externally_connectable` / no web-page messaging into the extension.
- Mutating browser tools and screenshots require Executor approval (host plugin).
- Navigate/open only allow `http:` / `https:` URLs.

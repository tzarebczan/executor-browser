# Architecture

| Piece | Role |
|-------|------|
| **Extension (MV3)** | Side panel UX, tab groups, local preview, API-key connect, reverse bridge |
| **Executor browser-bridge** | Session / long-poll jobs / results; catalogs `tools.browser.user.desktop` |

## Connect

1. User pastes Executor base URL + personal API key.
2. Extension `MCP initialize`s against `{base}/mcp` with Bearer.
3. On success, reverse session opens: `POST /api/browser-bridge/session`.
4. Extension long-polls `GET …/session/:id/jobs` and returns `POST …/result`.

No local Node companion and no `chrome.runtime.connectNative` host.

## Controllable tabs

Automation is restricted to the **tab group created and owned by the extension** (default title “Executor”). Foreign tabs and personal active tabs are never tool targets.

## Capture vs screenshot

| Path | Who | Destination |
|------|-----|-------------|
| **Capture** (UI button) | Human | Local side-panel preview only |
| **screenshot** tool | Agent | Reverse-bridge job result to Executor |

## Security notes

- No `externally_connectable` / no web-page messaging into the extension.
- Mutating browser tools and screenshots require Executor approval (host plugin).
- Navigate/open only allow `http:` / `https:` URLs.

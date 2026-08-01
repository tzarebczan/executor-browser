# Architecture

## Pieces

| Piece | Responsibility |
|-------|----------------|
| **Extension** | Side panel UX, tab groups, live preview, **API-key connect**, **path B reverse bridge tools** |
| **Native host (C)** | Optional one-time binary for full CDP via `chrome.runtime.connectNative` |
| **Companion** (legacy lab) | CDP → streamable MCP (`:9230`) for Executor HTTP pull |
| **Executor** | Tool catalog + policies; lab Serve on `:8444`; browser-bridge session API (for B) |

See also: [BRIDGE-MODES.md](./BRIDGE-MODES.md).

## Connect (default — no companion)

```text
Detect/probe https://lab-agents.<tailnet>.ts.net:8444
  → paste personal API key (Executor Settings → API keys)
  → MCP initialize with Bearer  →  "Connected"
```

Outbound only. Extension never needs an inbound port for this path.

## Browser automation

Path B exposes the extension-owned tab group as `tools.browser.user.desktop`:

```text
Executor (lab)  ──long poll──►  extension service worker
                                  │
                                  └── tabs / scripting → owned tab group
```

The optional native host or companion remains available for full CDP tooling.

## Why not pure CDP in the extension?

MV3 cannot safely own long-lived CDP the way a Node companion can. The extension:

- Groups tabs
- Captures what the user sees (`captureVisibleTab` + `<all_urls>`)
- Pairs with Executor via API key

Extension-native automation is restricted to the group created and owned by the extension.

## Register automation flow (advanced)

```text
Side panel "Register automation"
  → MCP initialize on Executor /mcp (Bearer API key)
  → tools/call execute {
       probeEndpoint(public MCP URL)
       addServer(slug: chrome)
       connections.create(name: desktop)
     }
```

`endpoint` is usually `http://<tailscale-ip>:9230/mcp`.

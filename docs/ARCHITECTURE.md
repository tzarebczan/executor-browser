# Architecture

## Pieces

| Piece | Responsibility |
|-------|----------------|
| **Extension** | Side panel UX, tab groups, live preview, **API-key connect over Tailscale** |
| **Companion** (optional) | CDP → streamable MCP (`:9230`) so *remote agents can drive* Chrome |
| **Executor** | Tool catalog + policies; lab Serve on `:8444`; `EXECUTOR_ALLOW_LOCAL_NETWORK` for private MCP |

## Connect (default — no companion)

```text
Detect/probe https://lab-agents.<tailnet>.ts.net:8444
  → paste personal API key (Executor Settings → API keys)
  → MCP initialize with Bearer  →  "Connected"
```

Outbound only. Extension never needs an inbound port for this path.

## Optional automation (companion / remote debugging)

Remote agents calling `tools.chrome.*` need a **browser MCP** Executor can reach:

```text
Executor (lab)  ──calls──►  http://<your-tailscale-ip>:9230/mcp  (companion)
                                │
                                └── CDP / remote debugging → Chrome
```

MV3 cannot listen on a port. So either:

1. Companion (or native host) exposes MCP on the laptop, or  
2. Future: reverse channel (extension WebSocket *to* Executor).

**Remote debugging** (`chrome://inspect/#remote-debugging`) is how the companion attaches to your real profile — it is not a substitute for the MCP endpoint.

## Why not pure CDP in the extension?

MV3 cannot safely own long-lived CDP the way a Node companion can. The extension:

- Groups tabs
- Captures what the user sees (`captureVisibleTab` + `<all_urls>`)
- Pairs with Executor via API key

Full automation (click, a11y snapshot) stays on the optional companion.

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

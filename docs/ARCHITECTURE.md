# Architecture

## Pieces

| Piece | Responsibility |
|-------|----------------|
| **Extension** | Side panel UX, tab groups, live JPEG preview, Executor API-key register |
| **Companion** | CDP → streamable MCP (`:9230`); not in this repo (lab: `tbd/infra/host/chrome-agent`) |
| **Executor** | Tool catalog + policies; self-host needs `EXECUTOR_ALLOW_LOCAL_NETWORK=true` for Tailscale |

## Why not pure CDP in the extension?

MV3 cannot safely own long-lived CDP the way a Node companion can. The extension:

- Groups tabs (Claude/Codex-like)
- Captures what the user sees (`captureVisibleTab`)
- Orchestrates pairing

Automation (click, a11y snapshot, console) stays on the companion.

## Register flow

```text
Side panel "Register with Executor"
  → MCP initialize on Executor /mcp (Bearer API key)
  → tools/call execute {
       probeEndpoint(endpoint)
       addServer(slug: chrome)
       connections.create(name: desktop)
     }
  → resume if approval pause
```

`endpoint` is usually `http://<tailscale-ip>:9230/mcp` for remote agents.

# Browser bridge modes (B + C)

## Goal

Remote agents on **Executor** (Tailscale) drive the user’s real Chrome **without**
asking them to run `node start-companion.mjs` every session.

| Mode | User install | Control plane | Fidelity |
|------|--------------|---------------|----------|
| **B · Extension reverse** (default) | Extension only | Extension dials **out** to Executor; polls/receives tool jobs | Good: tabs, navigate, snapshot, click, type, screenshot |
| **C · Native host** (Advanced) | Extension + **one-time** host install | `chrome.runtime.connectNative` → local binary (stdio) | Full CDP / chrome-devtools parity |
| **Legacy companion** (lab) | Node process on `:9230` | Executor HTTP → Tailscale IP | Full DevTools MCP |

## B — Extension reverse (primary)

```text
Lab agents → Executor tools.browser.user.desktop
                 ▲
                 │  long-poll / WS jobs + results
                 │
         Extension service worker
                 │
                 ▼
         chrome.tabs / scripting / captureVisibleTab
```

- Same trust as API key: **outbound** from the laptop (Tailscale to lab).
- No inbound port, no firewall rule, no Node script.
- Tool surface lives in `extension/lib/browser-tools.js`.

### Executor API

```http
POST /api/browser-bridge/session
Authorization: Bearer <api-key>
{ "kind": "chrome-extension", "transport": "reverse-longpoll", "capabilities": { ... } }
→ { "sessionId": "..." }

GET /api/browser-bridge/session/:id/jobs?waitMs=25000
→ { "jobs": [ { "id", "tool", "args" } ] }

POST /api/browser-bridge/session/:id/result
{ "jobId", "result" }
```

The extension reports ready only after the authenticated reverse session is live.
Web pages cannot pair with the extension or invoke browser tools directly.

## C — Native host (Advanced)

### Does “Chrome host manifest” mean no extra install?

**No.** The native messaging **host manifest** is a small JSON file Chrome reads
to find an **executable**:

```json
{
  "name": "com.executor.browser",
  "description": "Executor Browser host",
  "path": "C:\\\\Program Files\\\\ExecutorBrowser\\\\host.exe",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<id>/"]
}
```

- Manifest alone does nothing without the binary.
- After install, Chrome **spawns** the host on demand — user does **not** keep a
  terminal script running (unlike the lab companion).
- Shipping path: MSI / one-click installer that writes binary + registry key
  (Windows) or plist path (macOS). Extension can detect “host missing” and CTA.

Use C when you need full CDP (performance, multi-target, chrome-devtools MCP).

## CUA (computer use)

Separate from B/C:

```text
tools.browser.*   → B
tools.chrome.*    → C or the legacy companion
tools.computer.*  → CUA driver / sandbox (optional later)
```

Do not route logged-in browser work through CUA.

## Local agents as passthrough

Local Claude/Codex should call the **same bridge** (Executor or local MCP), not
“please click for me” chat. The reverse session / native host is a **tool server**;
chat agents are optional clients.

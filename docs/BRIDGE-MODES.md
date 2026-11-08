# Browser drive mode

Executor Browser supports **one** drive mode:

## Reverse bridge (default)

| | |
|--|--|
| **Client** | This extension |
| **Transport** | Authenticated HTTPS long-poll to Executor |
| **Tools** | `tools.browser.user.<connection>.*` via extension `chrome.tabs` / `scripting`. One connection per extension instance. |
| **Local process** | None |

```text
Agent → Executor browser channel → pending job
Extension ← GET /jobs ←
Extension → runBrowserTool → POST /result
```

### Requirements

- Executor v2 on this machine (`http://127.0.0.1:4312`) or a self-host on the tailnet. The browser channel is built into those servers.
- An API key for that server
- At least one tab in the extension-owned Executor group

### Not in scope (removed)

- **Native messaging host** (former path C / full CDP binary)
- **Lab companion** on `:9230` (former Node CDP MCP)

Those paths increased surface area and confused “connected” vs “drive ready.” Full CDP, if needed later, should be a separate product—not mixed into this extension’s default UX.

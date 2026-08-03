# Browser drive mode

Executor Browser supports **one** drive mode:

## Reverse bridge (default)

| | |
|--|--|
| **Client** | This extension |
| **Transport** | Authenticated HTTPS long-poll to Executor |
| **Tools** | `tools.browser.user.desktop.*` via extension `chrome.tabs` / `scripting` |
| **Local process** | None |

```text
Agent → Executor plugin callTool → pending job
Extension ← GET /jobs ←
Extension → runBrowserTool → POST /result
```

### Requirements

- Executor self-host with `@executor-js/plugin-browser-bridge` mounted
- User API key that can open reverse sessions
- At least one tab in the extension-owned Executor group

### Not in scope (removed)

- **Native messaging host** (former path C / full CDP binary)
- **Lab companion** on `:9230` (former Node CDP MCP)

Those paths increased surface area and confused “connected” vs “drive ready.” Full CDP, if needed later, should be a separate product—not mixed into this extension’s default UX.

# Path C — Native messaging host

## Host manifest ≠ install-free

Chrome’s **native messaging host manifest** is a JSON file that only **points at an executable**:

```json
{
  "name": "com.executor.browser",
  "description": "Executor Browser native host",
  "path": "C:\\Program Files\\ExecutorBrowser\\host.exe",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]
}
```

- Without the binary, Chrome reports *Specified native messaging host not found*.
- After install, Chrome **spawns** the host on demand — user does **not** keep a terminal open.
- Prefer shipping an MSI / one-click installer that writes binary + registry (Windows) or the host path (macOS/Linux).

## When to use C

- Need full CDP / chrome-devtools-mcp fidelity.
- Path B (extension reverse) is not enough (complex multi-target, perf tools, etc.).

Default product path remains **B** (extension only, no host).

## Status

Host binary is not packaged yet. Extension already:

- Requests `nativeMessaging` permission
- Calls `chrome.runtime.connectNative("com.executor.browser")`
- Surfaces “host missing” in Advanced

Next: implement stdio host that wraps chrome-devtools-mcp or thin CDP and answers `{type:"ping"}` / `{type:"tool"}`.

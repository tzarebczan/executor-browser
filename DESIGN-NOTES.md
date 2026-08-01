# Executor Browser — design notes (v0.2)

## Why preview was broken

Chrome error: *Either the `'<all_urls>'` or `'activeTab'` permission is required.*

- `tabs.captureVisibleTab` from the **side panel auto-refresh** is not a user gesture, so `activeTab` does not apply.
- Host permissions were `http://*/*` + `https://*/*` only; Chromium still requires the special **`<all_urls>`** host permission for capture in this path.
- **Fix:** `manifest.json` → `"host_permissions": ["<all_urls>", …]` and friendlier error copy when reload is still pending.
- **You must Reload** the unpacked extension on `chrome://extensions` after pull (still showed v0.1.0 until reload).

## UX goals applied

| Problem | Change |
| ------- | ------ |
| AI-slop (scanlines, glow grid, pulse orbs, button shine) | Removed; flat cards, calm chrome |
| Wall of form fields | **Tabs:** Home · Connect · Tabs · More |
| Slow “get connected” | Setup banner with checklist + quick actions when not ready |
| Wordy lab prose | Short labels; advanced MCP under `<details>` |
| No path grouping | Connect presets Lab Tailscale / Local; modes on Tabs |
| Focus-stealing auto capture | Soft capture without focusing window; focus only on manual Capture |

## Residual risks

1. User must **Reload** extension to pick up `<all_urls>` and v0.2 UI.
2. Companion offline until `Start-CompanionHidden.ps1` (now healthy if started).
3. Tailscale IP auto-detect depends on companion `/meta` (often manual paste).
4. Register still needs Executor API key + `EXECUTOR_ALLOW_LOCAL_NETWORK`.
5. Local Claude CLI OAuth was **expired** — could not complete a parallel Claude design job; re-run after `claude login`.

## Claude design session (attempted)

- Target: high-effort design pass on `extension/`
- Blocked: `Failed to authenticate: OAuth session expired`
- Session names tried: `executor-browser-sidebar-design`, `executor-sidebar-design` → failed immediately

After `claude login`, resume with:

```bash
cd C:\Users\thoma\Documents\executor-browser
claude --bg --name executor-sidebar-design --cwd . --effort high --permission-mode acceptEdits --allowedTools Read,Edit,Write,Glob,Grep,Bash "Review v0.2 sidebar design; polish further; apply edits"
```

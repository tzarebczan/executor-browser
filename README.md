# Executor Browser

Private Chrome extension that makes **browser control** feel as easy as Claude/Codex tab groups:

- **Side panel by default** (click the icon → panel, not a tiny popup)
- **Executor tab group** for agent-owned tabs
- **Live preview** of the active agent tab (JPEG capture + fun chrome UI)
- **One-click register** with self-hosted Executor (`tools.chrome.user.desktop`)
- Status, activity feed, modes (existing Chrome / fresh / extension-only)

Companion (CDP → MCP) still lives on the machine:

```text
extension (UX + tab groups + pair)
    │
    ▼
companion :9230  (chrome-devtools-mcp via infra/host/chrome-agent)
    │
    ▼
Chrome (remote debugging or fresh profile)
    │
    ▼
Executor  ←  http://<tailscale-ip>:9230/mcp   (ALLOW_LOCAL_NETWORK)
```

## Install (unpacked)

1. Start companion (from your monorepo / lab scripts):

   ```powershell
   # example — tbd lab
   powershell -ExecutionPolicy Bypass -File path\to\Start-CompanionHidden.ps1
   ```

2. Chrome → `chrome://extensions` → **Developer mode** → **Load unpacked**
3. Select the `extension/` folder in this repo
4. Pin **Executor Browser** — the **side panel** opens on click

## Connect (lab Tailscale)

1. Open the side panel  
2. **Executor URL** — e.g. `https://lab-agents.<tailnet>.ts.net:8444`  
3. **API key** — Executor personal API key  
4. **Public MCP URL** — `http://<your-desktop-tailscale-ip>:9230/mcp`  
5. **Register with Executor**  

Requires self-host:

```yaml
EXECUTOR_ALLOW_LOCAL_NETWORK: "true"
```

## Modes

| Mode | Meaning |
|------|---------|
| Existing Chrome | Remote debugging; keep cookies |
| Fresh profile | Companion launches isolated profile (scripted) |
| Extension-only | Groups + preview only (no CDP) |

## Privacy

- Private repo; do not commit API keys  
- Keys stored in `chrome.storage.local` on the user’s machine  
- Preview uses `tabs.captureVisibleTab` (visible tab JPEG only)

## Name

Repo: **`executor-browser`** — extension brand aligned with Executor, not a generic “browser extension.”

## License

Private / all rights reserved unless otherwise noted.

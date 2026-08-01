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

## Connect (default — no companion)

Users should **not** need a companion app to pair with Executor.

1. Open the side panel → **Connect**  
2. **Detect** fills lab URL (`https://lab-agents.<tailnet>.ts.net:8444`) when Tailscale is up  
3. Paste a **personal API key** from Executor → Settings → API keys  
4. **Connect** — MCP `initialize` with Bearer; green when valid  

Stored only in `chrome.storage.local` for this browser profile.

### Optional: browser automation (agents drive Chrome)

This is what the **public MCP URL** is for — not for basic connect.

| Piece | Role |
|-------|------|
| **API key connect** | Extension → Executor (outbound HTTPS). Pairing, tools, status. |
| **MCP endpoint** (`http://100.x:9230/mcp`) | Executor → your PC so agents can **control** the browser (CDP). |
| **Remote debugging** | How a companion attaches to your real Chrome profile. |

Without the MCP endpoint, agents cannot click/type/snapshot this Chrome remotely. With only the API key, you still get pairing, tab groups, and live preview.

Lab self-host for optional automation:

```yaml
EXECUTOR_ALLOW_LOCAL_NETWORK: "true"
```

## Modes

| Mode | Meaning |
|------|---------|
| Existing Chrome | Keep logins; optional remote debugging for automation |
| Fresh profile | Isolated window (automation helper) |
| Extension-only | Groups + preview · no CDP |

## Privacy

- Private repo; do not commit API keys  
- Keys stored in `chrome.storage.local` on the user’s machine  
- Preview uses `tabs.captureVisibleTab` (visible tab JPEG only)

## Name

Repo: **`executor-browser`** — extension brand aligned with Executor, not a generic “browser extension.”

## License

Private / all rights reserved unless otherwise noted.

# Executor Browser

Private Chrome extension that makes **browser control** feel as easy as Claude/Codex tab groups:

- **Side panel by default** (click the icon → panel, not a tiny popup)
- **API-key connect** to Executor over Tailscale
- **Path B (default):** extension reverse channel — **no local script**
- **Path C (Advanced):** native messaging host for full CDP (one-time binary install)
- **Legacy:** companion on `:9230` for lab DevTools MCP
- Tab group + live preview

```text
Path B (default):
  Extension ──outbound──► Executor browser-bridge session
       │                       ▲
       └── tabs/scripting ─────┘  (tool jobs long-polled)

Path C (Advanced):
  Extension ──nativeMessaging──► host binary ──CDP──► Chrome

Legacy companion:
  Executor ──HTTP──► http://<ts-ip>:9230/mcp ──CDP──► Chrome
```

Details: `docs/BRIDGE-MODES.md`

## Install (unpacked)

1. Chrome → `chrome://extensions` → **Developer mode** → **Load unpacked**
2. Select the `extension/` folder in this repo
3. Pin **Executor Browser** — the **side panel** opens on click

## Connect (default — no companion)

Users should **not** need a companion app to pair with Executor.

1. Open the side panel → **Connect**  
2. **Detect** fills lab URL (`https://lab-agents.<tailnet>.ts.net:8444`) when Tailscale is up  
3. Paste a **personal API key** from Executor → Settings → API keys  
4. **Connect** — MCP `initialize` with Bearer; green when valid  

Stored only in `chrome.storage.local` for this browser profile.

### Browser automation (agents drive Chrome)

The default reverse bridge exposes `tools.browser.user.desktop` without an inbound
port or companion process. Only tabs in the extension-owned Executor group are
visible to these tools.

| Piece | Role |
|-------|------|
| **API key connect** | Extension → Executor (outbound HTTPS). Pairing, tools, status. |
| **Reverse bridge** | Executor queues extension-native browser jobs over authenticated HTTPS. |
| **MCP endpoint** (`http://100.x:9230/mcp`) | Optional legacy companion for full CDP. |
| **Remote debugging** | Optional companion/native-host attachment to Chrome. |

With the API key and a live reverse session, agents can navigate, snapshot, click,
type, and capture screenshots in the owned tab group.

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

// Prefer the side panel — full options live under More → Advanced.
// This popup only mirrors companion URLs for chrome://extensions “Options”.
const health = document.getElementById("health");
const mcp = document.getElementById("mcp");
const groupTitle = document.getElementById("groupTitle");
const statusEl = document.getElementById("optStatus");

chrome.runtime.sendMessage({ type: "getStatus" }).then((s) => {
  health.value = s.settings?.companionHealthUrl || "http://127.0.0.1:9230/healthz";
  mcp.value = s.settings?.companionMcpUrl || "http://127.0.0.1:9230/mcp";
  groupTitle.value = s.settings?.groupTitle || "Executor";
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "saveSettings",
    settings: {
      companionHealthUrl: health.value.trim(),
      companionMcpUrl: mcp.value.trim(),
      groupTitle: groupTitle.value.trim() || "Executor",
    },
  });
  if (statusEl) {
    statusEl.textContent = "Saved. Prefer the side panel (extension icon) for Connect + agent setup.";
  }
});

document.getElementById("openSide")?.addEventListener("click", async () => {
  try {
    // Opens the side panel for the current window when available.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId != null && chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch {
    /* ignore */
  }
});

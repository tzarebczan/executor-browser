const groupTitle = document.getElementById("groupTitle");
const statusEl = document.getElementById("optStatus");

chrome.runtime.sendMessage({ type: "getStatus" }).then((s) => {
  groupTitle.value = s.settings?.groupTitle || "Executor";
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "saveSettings",
    settings: {
      groupTitle: groupTitle.value.trim() || "Executor",
    },
  });
  if (statusEl) {
    statusEl.textContent = "Saved. Prefer the side panel (extension icon) for Connect.";
  }
});

document.getElementById("openSide")?.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId != null && chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch {
    /* ignore */
  }
});

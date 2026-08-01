const health = document.getElementById("health");
const mcp = document.getElementById("mcp");
const groupTitle = document.getElementById("groupTitle");

chrome.runtime.sendMessage({ type: "getStatus" }).then((s) => {
  health.value = s.settings?.companionHealthUrl || "";
  mcp.value = s.settings?.companionMcpUrl || "";
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
  alert("Saved");
});

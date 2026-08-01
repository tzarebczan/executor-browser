const $ = (id) => document.getElementById(id);

function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function setStat(el, text, cls) {
  el.textContent = text;
  el.className = `stat-value ${cls || ""}`;
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "getStatus" });
  const { companion, settings, tabs, activity } = status;

  // Live dot + companion
  const live = $("liveDot");
  if (companion?.ok) {
    live.className = "live-dot on";
    setStat($("companionStat"), companion.ms != null ? `${companion.ms}ms` : "online", "ok");
  } else {
    live.className = "live-dot off";
    setStat($("companionStat"), "offline", "bad");
  }

  // MCP probe (async, non-blocking feel)
  chrome.runtime.sendMessage({ type: "probeMcp" }).then((mcp) => {
    if (mcp?.ok) setStat($("mcpStat"), "ready", "ok");
    else setStat($("mcpStat"), "n/a", "warn");
  });

  $("tabStat").textContent = String(tabs?.length || 0);

  // Form (don't overwrite API key if user is typing)
  if (document.activeElement?.id !== "executorUrl") {
    $("executorUrl").value = settings.executorUrl || "";
  }
  if (!$("publicEndpoint").value) {
    // default: localhost mcp; user should paste Tailscale if remote Executor
    $("publicEndpoint").placeholder = "http://100.x.x.x:9230/mcp or http://127.0.0.1:9230/mcp";
  }
  if (settings.hasApiKey && document.activeElement?.id !== "executorApiKey") {
    $("executorApiKey").placeholder = "•••• saved";
  }

  const mode = settings.mode || "existing";
  for (const el of document.querySelectorAll('input[name="mode"]')) {
    el.checked = el.value === mode;
  }

  // Tabs
  const list = $("tabList");
  if (!tabs?.length) {
    list.innerHTML = `<li class="empty">No tabs in group yet</li>`;
  } else {
    list.innerHTML = tabs
      .map(
        (t) => `
      <li>
        <button type="button" data-tab="${t.id}">
          ${escapeHtml(t.title || "Tab")}
          <span class="url">${escapeHtml(t.url || "")}</span>
        </button>
      </li>`,
      )
      .join("");
    list.querySelectorAll("button[data-tab]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.dataset.tab);
        await chrome.tabs.update(id, { active: true });
        await capture();
      });
    });
  }

  // Activity
  const act = $("activityList");
  if (!activity?.length) {
    act.innerHTML = `<li class="empty">Actions will show up here</li>`;
  } else {
    act.innerHTML = activity
      .slice(0, 12)
      .map(
        (a) => `
      <li>
        <span class="dot"></span>
        <span>${escapeHtml(a.message || a.kind || "event")}</span>
        <span class="when">${timeAgo(a.t)}</span>
      </li>`,
      )
      .join("");
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function capture() {
  $("btnCapture").disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "capturePreview" });
  $("btnCapture").disabled = false;
  if (!res?.ok) {
    $("previewEmpty").hidden = false;
    $("previewImg").hidden = true;
    $("previewUrl").textContent = res?.error || "capture failed";
    $("previewTitle").textContent = "—";
    return;
  }
  $("previewEmpty").hidden = true;
  const img = $("previewImg");
  img.hidden = false;
  img.src = res.dataUrl;
  $("previewUrl").textContent = res.tab?.url || "";
  $("previewTitle").textContent = res.tab?.title || "Preview";
}

$("btnRefresh").addEventListener("click", () => refresh());
$("btnCapture").addEventListener("click", () => capture());

$("btnOpenTab").addEventListener("click", async () => {
  const mode = document.querySelector('input[name="mode"]:checked')?.value || "existing";
  await chrome.runtime.sendMessage({ type: "saveSettings", settings: { mode } });
  await chrome.runtime.sendMessage({
    type: "openAgentTab",
    url: "https://tbd.jiggytom.com/",
  });
  await refresh();
  setTimeout(capture, 600);
  toast("Opened tab in Executor group");
});

$("btnDebug").addEventListener("click", async () => {
  await chrome.tabs.create({ url: "chrome://inspect/#remote-debugging" });
  toast("Enable remote debugging, then Allow once");
});

$("btnRegister").addEventListener("click", async () => {
  const btn = $("btnRegister");
  btn.disabled = true;
  $("connectHint").textContent = "Saving secrets & registering…";

  const executorUrl = $("executorUrl").value.trim();
  const executorApiKey = $("executorApiKey").value.trim();
  const endpoint = $("publicEndpoint").value.trim();

  await chrome.runtime.sendMessage({
    type: "saveSecrets",
    executorUrl,
    executorApiKey: executorApiKey || undefined,
  });

  const mode = document.querySelector('input[name="mode"]:checked')?.value;
  await chrome.runtime.sendMessage({ type: "saveSettings", settings: { mode } });

  const res = await chrome.runtime.sendMessage({
    type: "registerExecutor",
    endpoint: endpoint || undefined,
  });

  btn.disabled = false;
  if (res?.ok) {
    $("connectHint").textContent = "Registered tools.chrome.user.desktop — keep companion running.";
    toast("Executor connection registered", "ok");
  } else {
    $("connectHint").textContent =
      res?.error || res?.raw?.slice(0, 180) || "Register failed — check API key, ALLOW_LOCAL_NETWORK, companion.";
    toast(res?.error || "Register failed", "bad");
  }
  await refresh();
});

$("btnClearActivity").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearActivity" });
  await refresh();
});

// Auto-refresh + preview loop
refresh();
capture();
setInterval(refresh, 8000);
setInterval(() => {
  // soft auto-capture if companion online
  chrome.runtime.sendMessage({ type: "checkCompanion" }).then((c) => {
    if (c?.ok) capture();
  });
}, 15000);

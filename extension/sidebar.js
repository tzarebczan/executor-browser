const $ = (id) => document.getElementById(id);

let lastStatus = null;
let bootDone = false;

function hostLabel(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || "";
  }
}

function cdpModeFrom(settings) {
  if (settings?.cdpMode === "always" || settings?.cdpMode === "session" || settings?.cdpMode === "off") {
    return settings.cdpMode;
  }
  return settings?.advancedMode ? "session" : "off";
}

function paintGlance(status) {
  const glance = $("glance");
  const executor = status?.executor;
  const reverse = status?.reverse;
  const settings = status?.settings;
  let state = "checking";
  let text = "Looking for Executor…";

  if (!settings?.executorUrl && !executor?.ok) {
    state = "checking";
    text = "Looking for Executor…";
  } else if (executor && !executor.ok) {
    state = executor.verdict === "bridge-missing" ? "failed" : "offline";
    text = executor.error || "Executor is not reachable";
  } else if (!settings?.hasApiKey) {
    state = "checking";
    text = `Found ${hostLabel(settings?.executorUrl || executor?.url)}. Add the API key.`;
  } else if (reverse?.mode === "reverse" && reverse.running) {
    state = "connected";
    text = `Connected · ${hostLabel(settings.executorUrl)}`;
  } else if (reverse?.mode === "unsupported") {
    state = "failed";
    text = "This Executor has no browser control";
  } else if (reverse?.lastError) {
    state = "failed";
    text = reverse.lastError;
  } else {
    state = "checking";
    text = "Connecting…";
  }

  glance.dataset.state = state;
  glance.textContent = text;
}

function paintActivity(status) {
  const line = $("activityLine");
  const active = status?.reverse?.activeUse;
  const last = status?.activity?.[0];
  if (active?.summary) {
    line.textContent = active.summary;
    return;
  }
  if (last?.summary) {
    line.textContent = last.summary;
    return;
  }
  line.textContent = "Idle";
}

function paintCdp(status) {
  const mode = cdpModeFrom(status?.settings);
  for (const input of document.querySelectorAll('input[name="cdpMode"]')) {
    input.checked = input.value === mode;
  }
  const session = status?.controlSession;
  const row = $("sessionRow");
  const showWindow = mode === "session";
  row.hidden = !showWindow;
  $("cdpHint").textContent =
    mode === "always"
      ? "Debugger stays attached. Agents can use console, network, and page commands."
      : mode === "session"
        ? "Debugger attaches only while you allow it."
        : "Off. Agents can still open pages, click, and type.";
  if (!showWindow) return;
  const running = Boolean(session?.expiresAt && session.expiresAt > Date.now());
  $("sessionStatus").textContent = running
    ? `Allowed until ${new Date(session.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : "Not allowed right now";
  $("btnStartSession").hidden = running;
  $("btnEndSession").hidden = !running;
}

function paintConnection(status) {
  const settings = status?.settings || {};
  const form = $("connectForm");
  const bar = $("connectedBar");
  const url = $("executorUrl");
  if (document.activeElement !== url && settings.executorUrl) url.value = settings.executorUrl;
  const live = status?.reverse?.mode === "reverse" && status?.reverse?.running && settings.hasApiKey;
  form.hidden = live && form.dataset.forceEdit !== "1";
  bar.hidden = !live;
  if (live) {
    const where = hostLabel(settings.executorUrl);
    const address = status.reverse.address ? ` · ${status.reverse.address}` : "";
    $("connectedWhere").textContent = `${where}${address}`;
  }
  const key = $("executorApiKey");
  if (settings.hasApiKey && !key.value) key.placeholder = "Saved. Paste to replace.";
}

async function refresh() {
  lastStatus = await chrome.runtime.sendMessage({ type: "getStatus" });
  paintGlance(lastStatus);
  paintActivity(lastStatus);
  paintCdp(lastStatus);
  paintConnection(lastStatus);
  return lastStatus;
}

async function autoConnect({ quiet = true } = {}) {
  const settings = lastStatus?.settings;
  const url = $("executorUrl").value.trim() || settings?.executorUrl;
  if (!url) return { ok: false, skipped: true };
  const key = $("executorApiKey").value.trim();
  if (!key && !settings?.hasApiKey) return { ok: false, skipped: true };

  $("glance").dataset.state = "checking";
  $("glance").textContent = "Connecting…";
  await chrome.runtime.sendMessage({
    type: "saveSecrets",
    executorUrl: url,
    executorApiKey: key || undefined,
  });
  const res = await chrome.runtime.sendMessage({ type: "verifyExecutorAuth" });
  if (res?.ok) {
    $("executorApiKey").value = "";
    $("connectHint").textContent = quiet ? "" : "Connected";
    delete $("connectForm").dataset.forceEdit;
  } else {
    $("connectHint").textContent = res?.error || "Could not connect";
  }
  await refresh();
  return res;
}

function showFound(candidates) {
  const list = $("foundList");
  list.replaceChildren();
  if (!candidates?.length) {
    list.hidden = true;
    return;
  }
  list.hidden = false;
  for (const url of candidates) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = url;
    button.addEventListener("click", async () => {
      $("executorUrl").value = url;
      list.hidden = true;
      await chrome.runtime.sendMessage({ type: "saveSecrets", executorUrl: url });
      await refresh();
      await autoConnect({ quiet: true });
    });
    item.append(button);
    list.append(item);
  }
}

$("btnDetect").addEventListener("click", async () => {
  $("connectHint").textContent = "Looking for Executor…";
  $("glance").textContent = "Looking for Executor…";
  const typed = $("executorUrl").value.trim();
  const saved = lastStatus?.settings?.executorUrl || "";
  const res = await chrome.runtime.sendMessage({
    type: "detectExecutor",
    candidates: typed ? [typed] : [],
  });
  // The saved tailnet name is often just offline. A localhost answer must not
  // replace it. A different name the user typed, or an empty field, may.
  const keepSaved =
    Boolean(saved) && (!typed || typed === saved) && lastStatus?.executor?.verdict === "unreachable";
  if (res?.ok && res.url && !keepSaved) {
    $("executorUrl").value = res.url;
    $("connectHint").textContent = `Found ${hostLabel(res.url)}`;
    await chrome.runtime.sendMessage({ type: "saveSecrets", executorUrl: res.url });
    showFound([]);
    await refresh();
    await autoConnect({ quiet: true });
    return;
  }
  showFound(res?.tried || []);
  $("connectHint").textContent = keepSaved
    ? "Saved address is offline. Pick another only if you mean to switch."
    : res?.error || "No Executor found. Type the tailnet name.";
  await refresh();
});

$("btnConnect").addEventListener("click", async () => {
  const button = $("btnConnect");
  button.disabled = true;
  $("connectHint").textContent = "Connecting…";
  if (!$("executorUrl").value.trim()) {
    $("connectHint").textContent = "Type the Executor address first";
    button.disabled = false;
    return;
  }
  if (!$("executorApiKey").value.trim() && !lastStatus?.settings?.hasApiKey) {
    $("connectHint").textContent = "Paste the API key";
    button.disabled = false;
    return;
  }
  await autoConnect({ quiet: false });
  button.disabled = false;
});

$("btnDisconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "disconnectExecutor" });
  $("executorApiKey").value = "";
  $("executorApiKey").placeholder = "Personal API key";
  $("connectForm").dataset.forceEdit = "1";
  $("connectHint").textContent = "Disconnected";
  await refresh();
});

$("btnRefresh").addEventListener("click", async () => {
  await refresh();
  if (lastStatus?.settings?.hasApiKey && lastStatus?.executor?.ok) {
    await autoConnect({ quiet: true });
  }
});

for (const input of document.querySelectorAll('input[name="cdpMode"]')) {
  input.addEventListener("change", async () => {
    if (!input.checked) return;
    await chrome.runtime.sendMessage({
      type: "saveSettings",
      settings: {
        cdpMode: input.value,
        advancedMode: input.value !== "off",
      },
    });
    await refresh();
  });
}

$("btnStartSession").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "startControlSession" });
  await refresh();
});

$("btnEndSession").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "endControlSession" });
  await refresh();
});

$("executorApiKey").addEventListener("change", () => {
  autoConnect({ quiet: false });
});

(async () => {
  $("versionLabel").textContent = chrome.runtime.getManifest().version;

  await refresh();
  const saved = lastStatus?.settings?.executorUrl;
  // Search only when nothing is saved. An offline tailnet name, and a host
  // that answered but has no browser control yet, both stay put.
  if (!saved) {
    const found = await chrome.runtime.sendMessage({ type: "detectExecutor", candidates: [] });
    if (found?.ok && found.url) {
      $("executorUrl").value = found.url;
      await chrome.runtime.sendMessage({ type: "saveSecrets", executorUrl: found.url });
      await refresh();
    } else if (!lastStatus?.settings?.executorUrl) {
      $("connectHint").textContent = found?.error || "Type a tailnet name, or the Executor URL.";
    }
  }
  if (lastStatus?.settings?.hasApiKey) await autoConnect({ quiet: true });
  bootDone = true;
})();

setInterval(async () => {
  await refresh();
  if (lastStatus?.settings?.hasApiKey && lastStatus?.reverse?.mode !== "reverse" && lastStatus?.executor?.ok) {
    await autoConnect({ quiet: true });
  }
}, 15000);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings || !bootDone) return;
  refresh().catch(() => {});
});

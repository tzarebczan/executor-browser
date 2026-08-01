const $ = (id) => document.getElementById(id);

/** Known lab MagicDNS (tailnet-only Serve). */
const LAB_CANDIDATES = [
  "https://lab-agents.taile80474.ts.net:8444",
  "https://lab-agents.ts.net:8444",
];

let lastStatus = null;
let lastExecutorProbe = null;

function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
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

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function selectTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".panel").forEach((p) => {
    const on = p.dataset.panel === name;
    p.classList.toggle("active", on);
    p.hidden = !on;
  });
}

document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => selectTab(t.dataset.tab));
});
document.querySelectorAll("[data-goto]").forEach((el) => {
  el.addEventListener("click", () => selectTab(el.dataset.goto));
});

function renderSetup(settings, executorOk, companionOk) {
  const banner = $("setupBanner");
  const hasKey = Boolean(settings?.hasApiKey);
  const hasUrl = Boolean(settings?.executorUrl);
  const connected = Boolean(settings?.registeredAt) && executorOk;

  const steps = [];
  if (!hasUrl || !executorOk) {
    steps.push({ done: executorOk && hasUrl, text: "Reach Executor (Tailscale)" });
  } else {
    steps.push({ done: true, text: "Executor reachable" });
  }
  if (!hasKey) {
    steps.push({ done: false, text: "Paste personal API key" });
  } else if (!connected) {
    steps.push({ done: false, text: "Tap Connect to verify key" });
  } else {
    steps.push({ done: true, text: "API key connected" });
  }

  const allDone = steps.every((s) => s.done);
  if (allDone) {
    banner.hidden = true;
  } else {
    banner.hidden = false;
    $("setupSteps").innerHTML = steps
      .map(
        (s, i) => `
      <div class="setup-step ${s.done ? "done" : "todo"}">
        <span class="n">${s.done ? "✓" : i + 1}</span>
        <span>${escapeHtml(s.text)}</span>
      </div>`,
      )
      .join("");
    const actions = [];
    if (!executorOk) {
      actions.push(`<button type="button" class="primary sm" data-qa="detect">Detect Executor</button>`);
    }
    if (!hasKey || !connected) {
      actions.push(`<button type="button" class="primary sm" data-qa="connect">Connect…</button>`);
    }
    $("quickActions").innerHTML = actions.join("");
    $("quickActions").querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.dataset.qa === "detect") $("btnDetectExecutor").click();
        if (btn.dataset.qa === "connect") selectTab("connect");
      });
    });
  }

  if (!executorOk) $("headerStatus").textContent = "Executor unreachable";
  else if (!hasKey) $("headerStatus").textContent = "Paste API key to connect";
  else if (!connected) $("headerStatus").textContent = "Key saved · tap Connect";
  else if (companionOk) $("headerStatus").textContent = "Connected · automation on";
  else $("headerStatus").textContent = "Connected";
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "getStatus" });
  lastStatus = status;
  const { companion, settings, tabs, activity, executor } = status;
  lastExecutorProbe = executor ?? lastExecutorProbe;

  const executorOk = Boolean(executor?.ok);
  if (executorOk) {
    setStat($("executorStat"), executor.ms != null ? `${executor.ms}ms` : "online", "ok");
    $("executorReachHint").textContent = `Reachable · ${settings.executorUrl || "lab"}`;
  } else {
    setStat($("executorStat"), settings?.executorUrl ? "offline" : "—", "bad");
    $("executorReachHint").textContent =
      "Connect over Tailscale with a personal API key. No companion app required.";
  }

  if (companion?.ok) {
    setStat($("companionStat"), "on", "ok");
    $("companionDetail").textContent = `Companion healthy · ${companion.ms ?? "?"}ms`;
    $("autoSummary").textContent = "on";
  } else {
    setStat($("companionStat"), "off", "warn");
    $("companionDetail").textContent =
      companion?.error ||
      "Optional. Needed only if remote agents should drive this Chrome via CDP/MCP.";
    $("autoSummary").textContent = "off";
  }

  const n = tabs?.length || 0;
  $("tabStat").textContent = String(n);
  $("tabCount").textContent = String(n);

  if (document.activeElement?.id !== "executorUrl") {
    $("executorUrl").value = settings.executorUrl || "";
  }
  if (settings.publicEndpoint && document.activeElement?.id !== "publicEndpoint") {
    $("publicEndpoint").value = settings.publicEndpoint;
  }
  if (settings.hasApiKey && document.activeElement?.id !== "executorApiKey") {
    $("executorApiKey").placeholder = "•••• saved";
  }

  const mode = settings.mode || "existing";
  for (const el of document.querySelectorAll('input[name="mode"]')) {
    el.checked = el.value === mode;
  }

  const list = $("tabList");
  if (!tabs?.length) {
    list.innerHTML = `<li class="empty">No agent tabs</li>`;
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
        await chrome.tabs.update(Number(btn.dataset.tab), { active: true });
        await capture({ focus: false });
      });
    });
  }

  const act = $("activityList");
  if (!activity?.length) {
    act.innerHTML = `<li class="empty">Nothing yet</li>`;
  } else {
    act.innerHTML = activity
      .slice(0, 10)
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

  renderSetup(settings, executorOk, Boolean(companion?.ok));
}

function friendlyCaptureError(err) {
  const s = String(err || "");
  if (s.includes("<all_urls>") || s.includes("activeTab") || s.includes("permission")) {
    return "Reload the extension so preview permissions apply.";
  }
  if (s.includes("chrome://") || s.includes("Cannot access")) {
    return "Can't capture this page type — use a normal http(s) tab.";
  }
  return s.slice(0, 120) || "Capture failed";
}

async function capture({ focus = false } = {}) {
  $("btnCapture").disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "capturePreview", focus });
  $("btnCapture").disabled = false;
  const errEl = $("previewError");
  if (!res?.ok) {
    $("previewEmpty").hidden = false;
    $("previewImg").hidden = true;
    const msg = friendlyCaptureError(res?.error);
    $("previewUrl").textContent = "Capture failed";
    $("previewTitle").textContent = "—";
    $("previewEmptyTitle").textContent = "No live frame";
    $("previewEmptyHint").textContent = msg;
    errEl.hidden = false;
    errEl.textContent = msg;
    return;
  }
  errEl.hidden = true;
  $("previewEmpty").hidden = true;
  const img = $("previewImg");
  img.hidden = false;
  img.src = res.dataUrl;
  $("previewUrl").textContent = res.tab?.url || "";
  $("previewTitle").textContent = res.tab?.title || "Preview";
}

async function openAgentTab() {
  const mode = document.querySelector('input[name="mode"]:checked')?.value || "existing";
  await chrome.runtime.sendMessage({ type: "saveSettings", settings: { mode } });
  await chrome.runtime.sendMessage({
    type: "openAgentTab",
    url: "https://tbd.jiggytom.com/",
  });
  await refresh();
  setTimeout(() => capture({ focus: false }), 700);
  toast("Opened agent tab");
}

async function saveMode() {
  const mode = document.querySelector('input[name="mode"]:checked')?.value;
  if (mode) await chrome.runtime.sendMessage({ type: "saveSettings", settings: { mode } });
}

document.querySelectorAll("[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-preset]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    if (btn.dataset.preset === "lab") {
      $("executorUrl").value = LAB_CANDIDATES[0];
      $("labBadge").textContent = "Lab";
    } else {
      $("labBadge").textContent = "Custom";
      $("executorUrl").focus();
    }
  });
});

$("btnRefresh").addEventListener("click", () => refresh());
$("btnCapture").addEventListener("click", () => capture({ focus: true }));
$("btnCaptureTabs")?.addEventListener("click", () => capture({ focus: true }));
$("btnOpenTab").addEventListener("click", () => openAgentTab());
$("btnOpenTabHome").addEventListener("click", () => openAgentTab());

$("btnDebug").addEventListener("click", async () => {
  try {
    await chrome.tabs.create({ url: "chrome://inspect/#remote-debugging" });
    toast("Allow remote debugging once");
  } catch {
    toast("Open chrome://inspect/#remote-debugging manually", "bad");
  }
});

$("btnCopyCompanionCmd")?.addEventListener("click", async () => {
  const cmd =
    $("companionCmd")?.textContent?.trim() ||
    "node infra/host/chrome-agent/start-companion.mjs";
  try {
    await navigator.clipboard.writeText(cmd);
    toast("Copied — run from tbd repo (Node 18+). Win/macOS/Linux.");
  } catch {
    toast(cmd, "ok");
  }
});

$("btnRecheckCompanion")?.addEventListener("click", async () => {
  $("companionDetail").textContent = "Checking companion on :9230…";
  await refresh();
  const c = lastStatus?.companion;
  if (c?.ok) {
    toast("Companion online");
    $("companionDetail").textContent = `Companion healthy · ${c.ms ?? "?"}ms on 127.0.0.1:9230`;
  } else {
    toast("Companion offline — run the PowerShell start script", "bad");
    $("companionDetail").textContent =
      c?.error ||
      "Offline. From tbd repo: Start-CompanionHidden.ps1 (after remote debugging Allow).";
  }
});

$("btnDetectExecutor").addEventListener("click", async () => {
  $("connectHint").textContent = "Probing lab Executor…";
  const res = await chrome.runtime.sendMessage({
    type: "detectExecutor",
    candidates: LAB_CANDIDATES.concat([$("executorUrl").value.trim()].filter(Boolean)),
  });
  if (res?.ok && res.url) {
    $("executorUrl").value = res.url;
    await chrome.runtime.sendMessage({
      type: "saveSecrets",
      executorUrl: res.url,
    });
    $("connectHint").textContent = `Found Executor · ${res.ms ?? "?"}ms · ${res.url}`;
    toast("Executor found");
  } else {
    $("connectHint").textContent =
      res?.error || "Not reachable. Join Tailscale and try again, or paste the URL.";
    toast("Executor not found", "bad");
  }
  await refresh();
});

$("btnTestExecutor").addEventListener("click", async () => {
  const url = $("executorUrl").value.trim();
  if (!url) {
    toast("Enter base URL first", "bad");
    return;
  }
  await chrome.runtime.sendMessage({ type: "saveSecrets", executorUrl: url });
  const res = await chrome.runtime.sendMessage({ type: "probeExecutor" });
  if (res?.ok) {
    $("connectHint").textContent = `OK · HTTP ${res.status ?? 200} · ${res.ms ?? "?"}ms`;
    toast("Executor reachable");
  } else {
    $("connectHint").textContent = res?.error || "Unreachable";
    toast("Probe failed", "bad");
  }
  await refresh();
});

/** Same WebRTC trick in the side panel (more reliable than SW). */
function detectTsWebRtc(timeoutMs = 2800) {
  return new Promise((resolve) => {
    const ips = new Set();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      resolve([...ips].find((ip) => /^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) || null);
    };
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
    } catch {
      resolve(null);
      return;
    }
    pc.createDataChannel("");
    pc.onicecandidate = (ev) => {
      const c = ev.candidate?.candidate;
      if (!c) return;
      const m = c.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
      if (m) ips.add(m[1]);
    };
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .catch(() => finish());
    setTimeout(finish, timeoutMs);
  });
}

$("btnDetectTs").addEventListener("click", async () => {
  $("advAutomation").open = true;
  toast("Detecting Tailscale IP…");
  // Panel WebRTC first (Executor 30ms only proves *server* is up, not *your* IP)
  let ip = await detectTsWebRtc();
  let source = "webrtc";
  if (!ip) {
    const res = await chrome.runtime.sendMessage({ type: "detectTailscale" });
    if (res?.ok && res.ip) {
      ip = res.ip;
      source = res.source || "bg";
    } else {
      toast(res?.error || "Could not detect Tailscale IP", "bad");
      $("connectHint").textContent =
        "Executor online ≠ desktop Tailscale IP. Run `tailscale ip -4` and paste http://100.x.x.x:9230/mcp";
      return;
    }
  }
  $("publicEndpoint").value = `http://${ip}:9230/mcp`;
  toast(`Tailscale ${ip} (${source})`);
  $("connectHint").textContent = `MCP URL set from ${source}: http://${ip}:9230/mcp`;
});

/** Primary connect: verify API key against Executor MCP (no companion). */
$("btnConnect").addEventListener("click", async () => {
  const btn = $("btnConnect");
  btn.disabled = true;
  $("connectHint").textContent = "Verifying API key…";

  const executorUrl = $("executorUrl").value.trim();
  const executorApiKey = $("executorApiKey").value.trim();
  if (!executorUrl) {
    $("connectHint").textContent = "Base URL required.";
    btn.disabled = false;
    return;
  }
  if (!executorApiKey && !lastStatus?.settings?.hasApiKey) {
    $("connectHint").textContent = "Paste a personal API key from Executor settings.";
    btn.disabled = false;
    return;
  }

  await chrome.runtime.sendMessage({
    type: "saveSecrets",
    executorUrl,
    executorApiKey: executorApiKey || undefined,
  });
  await saveMode();

  const res = await chrome.runtime.sendMessage({ type: "verifyExecutorAuth" });
  btn.disabled = false;
  if (res?.ok) {
    $("connectHint").textContent = "Connected. API key works with Executor MCP.";
    toast("Connected to Executor");
    await chrome.runtime.sendMessage({
      type: "saveSettings",
      settings: { registeredAt: Date.now() },
    });
  } else {
    $("connectHint").textContent =
      res?.error ||
      "Auth failed. Check the key (Settings → API keys) and that you're on Tailscale.";
    toast(res?.error || "Connect failed", "bad");
  }
  await refresh();
});

/** Optional: register companion MCP so agents can drive the browser. */
$("btnRegisterAutomation").addEventListener("click", async () => {
  const endpoint = $("publicEndpoint").value.trim();
  $("connectHint").textContent = "Registering automation endpoint…";
  await chrome.runtime.sendMessage({
    type: "saveSecrets",
    executorUrl: $("executorUrl").value.trim() || undefined,
    executorApiKey: $("executorApiKey").value.trim() || undefined,
    publicEndpoint: endpoint || undefined,
  });
  const res = await chrome.runtime.sendMessage({
    type: "registerExecutor",
    endpoint: endpoint || undefined,
  });
  if (res?.ok) {
    $("connectHint").textContent = "Automation registered · tools.chrome.user.desktop";
    toast("Automation registered");
  } else {
    $("connectHint").textContent =
      res?.error ||
      "Register failed — need companion/MCP up, Tailscale IP, ALLOW_LOCAL_NETWORK.";
    toast(res?.error || "Register failed", "bad");
    $("advAutomation").open = true;
  }
  await refresh();
});

$("btnClearActivity").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearActivity" });
  await refresh();
});

document.querySelectorAll('input[name="mode"]').forEach((el) => {
  el.addEventListener("change", () => saveMode());
});

function buildAgentPrompt(settings) {
  const url = settings?.executorUrl || LAB_CANDIDATES[0];
  const mcp = (url || "").replace(/\/$/, "") + "/mcp";
  const publicMcp =
    settings?.publicEndpoint ||
    $("publicEndpoint")?.value?.trim() ||
    "http://<your-tailscale-ip>:9230/mcp";
  return [
    "You have access to Executor MCP tools.",
    `Executor base: ${url}`,
    `Executor MCP: ${mcp}`,
    "",
    "If browser control is registered:",
    `- Chrome MCP endpoint (desktop): ${publicMcp}`,
    "- Use tools.chrome / executor browser tools against my desktop connection.",
    "- Prefer take_snapshot over screenshots. Don't start performance traces.",
    "",
    "If browser tools are unavailable, say so and continue with non-browser tools.",
  ].join("\n");
}

function fillAgentPrompt(settings) {
  const el = $("agentPrompt");
  if (el) el.value = buildAgentPrompt(settings || lastStatus?.settings || {});
}

$("btnCopyAgentPrompt")?.addEventListener("click", async () => {
  fillAgentPrompt(lastStatus?.settings);
  const text = $("agentPrompt")?.value || buildAgentPrompt(lastStatus?.settings);
  try {
    await navigator.clipboard.writeText(text);
    toast("Agent prompt copied");
  } catch {
    toast("Select the box and copy manually", "bad");
  }
});

$("btnGoConnect")?.addEventListener("click", () => selectTab("connect"));

$("btnSaveAdvanced")?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "saveSettings",
    settings: {
      companionHealthUrl: $("healthUrl")?.value.trim() || undefined,
      companionMcpUrl: $("mcpUrl")?.value.trim() || undefined,
      groupTitle: $("groupTitle")?.value.trim() || "Executor",
    },
  });
  if ($("advancedHint")) $("advancedHint").textContent = "Saved advanced settings.";
  toast("Advanced settings saved");
  await refresh();
});

// Boot: detect if empty, then refresh
(async () => {
  await refresh();
  if (!lastStatus?.settings?.executorUrl) {
    const det = await chrome.runtime.sendMessage({
      type: "detectExecutor",
      candidates: LAB_CANDIDATES,
    });
    if (det?.ok && det.url) {
      await chrome.runtime.sendMessage({ type: "saveSecrets", executorUrl: det.url });
      $("executorUrl").value = det.url;
    } else {
      $("executorUrl").value = LAB_CANDIDATES[0];
    }
  }
  // Prefill advanced fields from settings
  const s = lastStatus?.settings;
  if ($("healthUrl")) $("healthUrl").value = s?.companionHealthUrl || "http://127.0.0.1:9230/healthz";
  if ($("mcpUrl")) $("mcpUrl").value = s?.companionMcpUrl || "http://127.0.0.1:9230/mcp";
  if ($("groupTitle")) $("groupTitle").value = s?.groupTitle || "Executor";
  fillAgentPrompt(s);
  await refresh();
  fillAgentPrompt(lastStatus?.settings);
  // Soft capture — never block on failure
  setTimeout(() => capture({ focus: false }), 500);
})();

setInterval(() => {
  refresh().then(() => fillAgentPrompt(lastStatus?.settings));
}, 12000);

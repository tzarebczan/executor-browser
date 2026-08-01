const $ = (id) => document.getElementById(id);

/** Known lab MagicDNS (tailnet-only Serve). */
const LAB_CANDIDATES = [
  "https://lab-agents.taile80474.ts.net:8444",
  "https://lab-agents.ts.net:8444",
];

let lastStatus = null;
let lastExecutorProbe = null;
/** Auth verified this session (MCP initialize + key). */
let authOk = false;
let authChecking = false;
/** Automation register result this session. */
let automationOk = false;
let bootDone = false;

function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
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

/**
 * @param {string} state ok | bad | warn | run | off | skip
 * @param {string} label
 * @param {string} detail
 * @param {{ optional?: boolean }} opts
 */
function matrixRow(state, label, detail = "", opts = {}) {
  const icon =
    state === "ok"
      ? "✓"
      : state === "run"
        ? "…"
        : state === "warn"
          ? "!"
          : state === "skip" || state === "off"
            ? "○"
            : "✕";
  const cls = [state, opts.optional ? "is-optional" : ""].filter(Boolean).join(" ");
  // detail as pill — never ellipsis-cut mid-word in narrow panel
  const detailHtml = detail
    ? `<span class="mx-pill ${state}">${escapeHtml(detail)}</span>`
    : "";
  return `<li class="mx ${cls}">
    <span class="mx-left">
      <span class="mx-icon" aria-hidden="true">${icon}</span>
      <span class="mx-label">${escapeHtml(label)}</span>
    </span>
    ${detailHtml}
  </li>`;
}

function deriveFlags(status) {
  const settings = status?.settings || {};
  const executor = status?.executor || lastExecutorProbe;
  const companion = status?.companion;
  const executorReach = Boolean(executor?.ok);
  const hasKey = Boolean(settings.hasApiKey);
  const registeredAt = Boolean(settings.registeredAt);
  const companionOn = Boolean(companion?.ok);
  const hasEndpoint = Boolean(settings.publicEndpoint || $("publicEndpoint")?.value?.trim());
  // session auth wins; fall back to registeredAt if we verified before
  const connected = authOk || (registeredAt && hasKey && executorReach);
  return {
    settings,
    executor,
    companion,
    executorReach,
    hasKey,
    connected,
    companionOn,
    hasEndpoint,
    automationOk: automationOk || Boolean(settings.chromeRegistered),
    tabs: status?.tabs?.length || 0,
  };
}

function renderConnectState(f) {
  const banner = $("connBanner");
  const form = $("connectForm");
  const connectedActions = $("connectedActions");
  const connectActions = $("connectActions");
  const card = $("connectCard");
  const tabDot = $("connectTabDot");
  const tabBtn = $("tabConnect");
  const url = f.settings?.executorUrl || "";
  const shortUrl = url.replace(/^https?:\/\//, "").replace(/\/$/, "");

  let state = "bad";
  let title = "Not connected";
  let sub = "Paste API key and connect";

  if (authChecking) {
    state = "run";
    title = "Connecting…";
    sub = shortUrl || "Verifying API key";
  } else if (f.connected && f.executorReach) {
    state = "ok";
    title = "Connected";
    sub = shortUrl + (f.executor?.ms != null ? ` · ${f.executor.ms}ms` : "");
  } else if (f.connected && !f.executorReach) {
    state = "warn";
    title = "Connected · unreachable";
    sub = shortUrl || "Tailscale / URL down";
  } else if (f.hasKey && f.executorReach) {
    state = "warn";
    title = "Key saved · not verified";
    sub = "Tap Connect or wait for auto-connect";
  } else if (f.executorReach) {
    state = "warn";
    title = "Reachable · needs key";
    sub = shortUrl || "Paste personal API key";
  } else {
    state = "bad";
    title = "Not connected";
    sub = f.settings?.executorUrl ? "Executor offline" : "Detect URL or join Tailscale";
  }

  if (banner) {
    banner.dataset.state = state;
    if ($("connTitle")) $("connTitle").textContent = title;
    if ($("connSub")) $("connSub").textContent = sub;
  }

  const fullyOk = f.connected && f.executorReach && !authChecking;

  if (card) card.classList.toggle("is-connected", fullyOk);
  if (form) {
    // Keep form hidden when connected unless user opened edit
    if (fullyOk && !form.dataset.forceEdit) form.classList.add("is-collapsed");
    if (!fullyOk) {
      form.classList.remove("is-collapsed");
      delete form.dataset.forceEdit;
    }
  }
  if (connectedActions) connectedActions.hidden = !fullyOk;
  if (connectActions) connectActions.hidden = fullyOk && !form?.dataset.forceEdit;
  if ($("btnConnect")) $("btnConnect").hidden = fullyOk && !form?.dataset.forceEdit;

  // Tab title + green dot
  if ($("connectTabLabel")) {
    $("connectTabLabel").textContent = fullyOk ? "Connected" : "Connect";
  }
  if (tabDot) {
    if (fullyOk) {
      tabDot.hidden = false;
      tabDot.className = "tab-dot";
    } else if (authChecking) {
      tabDot.hidden = false;
      tabDot.className = "tab-dot warn";
    } else if (f.hasKey || f.executorReach) {
      tabDot.hidden = false;
      tabDot.className = "tab-dot warn";
    } else {
      tabDot.hidden = true;
    }
  }

  if ($("connectDriveBlurb")) {
    if (f.automationOk) {
      $("connectDriveBlurb").textContent =
        "Remote tools.chrome.* active via companion. Extension tab group is for local organization.";
    } else if (f.companionOn) {
      $("connectDriveBlurb").textContent =
        "Companion running — Register under Advanced so Executor can call this Chrome.";
    } else {
      $("connectDriveBlurb").textContent =
        "You’re connected for Executor API. Remote click/type needs companion (MV3 can’t expose MCP). Extension still handles pair, tab group, preview.";
    }
  }
}

function renderMatrices(status) {
  const f = deriveFlags(status);
  const reachDetail = f.executorReach
    ? `${f.executor?.ms != null ? f.executor.ms + "ms" : "up"}`
    : f.settings.executorUrl
      ? "offline"
      : "no URL";
  const authDetail = authChecking
    ? "checking"
    : f.connected
      ? "verified"
      : f.hasKey
        ? "key saved"
        : "no key";
  const authState = authChecking ? "run" : f.connected ? "ok" : f.hasKey ? "warn" : "bad";

  // Connect: compact checks under banner
  const connectRows = [
    matrixRow(f.executorReach ? "ok" : "bad", "Reachable", reachDetail),
    matrixRow(authState, "Auth", authDetail),
  ].join("");

  let drivePill;
  if (f.automationOk) drivePill = "on";
  else if (f.companionOn) drivePill = "local only";
  else drivePill = "off";

  const connectOptRows = [
    matrixRow(
      f.automationOk ? "ok" : f.companionOn ? "warn" : "skip",
      "tools.chrome.*",
      drivePill,
      { optional: true },
    ),
  ].join("");

  renderConnectState(f);

  // Agents → Core (required)
  const coreRows = [
    matrixRow(f.executorReach ? "ok" : "bad", "Executor", reachDetail),
    matrixRow(authState, "API key", authDetail),
    matrixRow(
      f.tabs > 0 ? "ok" : "skip",
      "Agent tabs",
      f.tabs > 0 ? String(f.tabs) : "none yet",
    ),
  ].join("");

  // Agents → Browser drive (optional; empty ≠ broken)
  let companionDetail;
  let companionState;
  if (f.companionOn) {
    companionState = "ok";
    companionDetail = `${f.companion?.ms ?? "?"}ms · :9230`;
  } else {
    companionState = "skip";
    companionDetail = "not running";
  }

  // Chrome tools = companion registered on Executor (≠ Executor /mcp)
  let chromeState;
  let chromeDetail;
  if (f.automationOk) {
    chromeState = "ok";
    chromeDetail = "registered";
  } else if (!f.companionOn) {
    chromeState = "skip";
    chromeDetail = "needs companion";
  } else if (f.hasEndpoint) {
    chromeState = "warn";
    chromeDetail = "not registered";
  } else {
    chromeState = "skip";
    chromeDetail = "not registered";
  }

  const driveRows = [
    matrixRow(companionState, "Companion", companionDetail, { optional: true }),
    matrixRow(chromeState, "Chrome tools", chromeDetail, { optional: true }),
  ].join("");

  const advRows = [
    matrixRow(
      f.companionOn ? "ok" : "skip",
      "Companion",
      f.companionOn ? "healthy" : "optional · off",
      { optional: true },
    ),
    matrixRow(
      f.hasEndpoint ? "ok" : "skip",
      "Public MCP URL",
      f.hasEndpoint ? "set" : "auto on detect",
      { optional: true },
    ),
    matrixRow(
      f.automationOk ? "ok" : "skip",
      "Registered to Executor",
      f.automationOk ? "yes" : "optional",
      { optional: true },
    ),
  ].join("");

  if ($("connectMatrix")) $("connectMatrix").innerHTML = connectRows;
  if ($("connectMatrixOpt")) $("connectMatrixOpt").innerHTML = connectOptRows;
  if ($("agentMatrixCore")) $("agentMatrixCore").innerHTML = coreRows;
  if ($("agentMatrixDrive")) $("agentMatrixDrive").innerHTML = driveRows;
  if ($("agentMatrix") && !$("agentMatrixCore")) $("agentMatrix").innerHTML = coreRows + driveRows;
  if ($("advMatrix")) $("advMatrix").innerHTML = advRows;

  if ($("useBadge")) {
    if (!f.connected) {
      $("useBadge").textContent = "setup";
      $("useBadge").className = "badge soft";
    } else if (f.automationOk) {
      $("useBadge").textContent = "full";
      $("useBadge").className = "badge";
    } else {
      $("useBadge").textContent = "API only";
      $("useBadge").className = "badge";
    }
  }

  if ($("coreTag")) {
    $("coreTag").textContent = f.connected && f.executorReach ? "ok" : "required";
    $("coreTag").className = f.connected && f.executorReach ? "mx-tag ok-tag" : "mx-tag";
  }

  if ($("driveBlurb")) {
    if (f.automationOk) {
      $("driveBlurb").textContent = "tools.chrome.user.desktop registered — agents can drive Chrome.";
    } else if (f.companionOn) {
      $("driveBlurb").textContent =
        "Companion up. Advanced → Register to expose tools.chrome.* to Executor.";
    } else {
      $("driveBlurb").textContent =
        "Extension ≠ remote CDP. Pair + tabs + preview work now; remote click/type needs companion MCP.";
    }
  }

  if ($("nextHint")) {
    if (!f.executorReach) $("nextHint").textContent = "Not connected: Tailscale / Detect.";
    else if (!f.hasKey) $("nextHint").textContent = "Not connected: paste API key.";
    else if (!f.connected) $("nextHint").textContent = "Not connected: auth failed or verifying.";
    else if (f.automationOk) $("nextHint").textContent = "Connected + remote browser tools.";
    else $("nextHint").textContent = "Connected to Executor. Remote browser tools off (companion).";
  }

  if ($("advSummary")) {
    $("advSummary").textContent = f.automationOk
      ? "on"
      : f.companionOn
        ? "companion up"
        : "optional · off";
  }
}

function renderSetup(status) {
  const banner = $("setupBanner");
  const f = deriveFlags(status);
  const steps = [];

  if (!f.executorReach) steps.push({ done: false, text: "Reach Executor (Tailscale)" });
  else steps.push({ done: true, text: "Executor reachable" });

  if (!f.hasKey) steps.push({ done: false, text: "Paste API key" });
  else if (!f.connected) steps.push({ done: authChecking, text: authChecking ? "Verifying…" : "Connect" });
  else steps.push({ done: true, text: "Auth OK" });

  const allDone = f.connected && f.executorReach;
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
    if (!f.executorReach) {
      actions.push(`<button type="button" class="primary sm" data-qa="detect">Detect</button>`);
    }
    if (!f.hasKey || !f.connected) {
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

  // Header
  if (authChecking) $("headerStatus").textContent = "Connecting…";
  else if (!f.executorReach) $("headerStatus").textContent = "Executor offline";
  else if (!f.hasKey) $("headerStatus").textContent = "Needs API key";
  else if (!f.connected) $("headerStatus").textContent = "Auth failed";
  else if (f.automationOk) $("headerStatus").textContent = "Connected · automation";
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
  } else {
    setStat($("executorStat"), settings?.executorUrl ? "offline" : "—", "bad");
  }

  // Home strip: automation = companion + register when known
  if (automationOk || (companion?.ok && settings?.publicEndpoint && settings?.registeredAt)) {
    setStat($("companionStat"), "on", "ok");
  } else if (companion?.ok) {
    setStat($("companionStat"), "local", "warn");
  } else {
    setStat($("companionStat"), "off", "warn");
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

  // If we previously registered and still have key + reach, treat as connected
  if (settings.registeredAt && settings.hasApiKey && executorOk && !authOk && !authChecking) {
    authOk = true;
  }

  renderSetup(status);
  renderMatrices(status);
  fillAgentPrompt(settings);
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

/** Auto-verify API key against Executor MCP. */
async function autoConnect({ quiet = true } = {}) {
  const s = lastStatus?.settings;
  if (!s?.hasApiKey && !$("executorApiKey")?.value?.trim()) return { ok: false, skipped: true };
  const url = $("executorUrl")?.value?.trim() || s?.executorUrl;
  if (!url) return { ok: false, skipped: true };

  authChecking = true;
  renderSetup(lastStatus);
  renderMatrices(lastStatus);

  const key = $("executorApiKey")?.value?.trim();
  await chrome.runtime.sendMessage({
    type: "saveSecrets",
    executorUrl: url,
    executorApiKey: key || undefined,
  });

  const res = await chrome.runtime.sendMessage({ type: "verifyExecutorAuth" });
  authChecking = false;
  if (res?.ok) {
    authOk = true;
    await chrome.runtime.sendMessage({
      type: "saveSettings",
      settings: { registeredAt: Date.now() },
    });
    if (!quiet) {
      $("connectHint").textContent = "Connected";
      toast("Connected");
    } else if ($("connectHint")) {
      $("connectHint").textContent = "Auto-connected";
    }
  } else {
    authOk = false;
    if ($("connectHint")) {
      $("connectHint").textContent = res?.error || "Auth failed";
    }
    if (!quiet) toast(res?.error || "Connect failed", "bad");
  }
  await refresh();
  return res;
}

/** WebRTC Tailscale IP (panel). */
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

/** Advanced: find companion + TS IP; register if auth + companion ready. */
async function autoAdvanced({ register = true } = {}) {
  const companion = await chrome.runtime.sendMessage({ type: "checkCompanion" });
  if (!companion?.ok) {
    if ($("advancedHint")) $("advancedHint").textContent = "Companion offline";
    automationOk = false;
    await refresh();
    return { companion: false };
  }

  let endpoint = $("publicEndpoint")?.value?.trim() || lastStatus?.settings?.publicEndpoint;
  if (!endpoint) {
    let ip = await detectTsWebRtc();
    if (!ip) {
      const res = await chrome.runtime.sendMessage({ type: "detectTailscale" });
      if (res?.ok && res.ip) ip = res.ip;
    }
    if (ip) {
      endpoint = `http://${ip}:9230/mcp`;
      $("publicEndpoint").value = endpoint;
      await chrome.runtime.sendMessage({ type: "saveSecrets", publicEndpoint: endpoint });
    }
  }

  if (!register || !authOk || !endpoint) {
    if ($("advancedHint")) {
      $("advancedHint").textContent = endpoint
        ? `Companion up · ${endpoint}`
        : "Companion up · set MCP URL";
    }
    await refresh();
    return { companion: true, endpoint, registered: false };
  }

  // Already registered
  if (lastStatus?.settings?.chromeRegistered && lastStatus?.settings?.publicEndpoint === endpoint) {
    automationOk = true;
    if ($("advancedHint")) $("advancedHint").textContent = "Automation already registered";
    await refresh();
    return { companion: true, endpoint, registered: true };
  }

  if ($("advancedHint")) $("advancedHint").textContent = "Registering automation…";
  const res = await chrome.runtime.sendMessage({
    type: "registerExecutor",
    endpoint,
  });
  automationOk = Boolean(res?.ok);
  if ($("advancedHint")) {
    $("advancedHint").textContent = res?.ok
      ? "Automation registered"
      : res?.error || "Register failed";
  }
  if (res?.ok) toast("Automation on");
  await refresh();
  return { companion: true, endpoint, registered: automationOk };
}

// ── events ──────────────────────────────────────────────

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

$("btnRefresh").addEventListener("click", async () => {
  await refresh();
  await autoConnect({ quiet: true });
  await autoAdvanced({ register: true });
});

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
    toast("Copied");
  } catch {
    toast(cmd, "ok");
  }
});

$("btnRecheckCompanion")?.addEventListener("click", async () => {
  await autoAdvanced({ register: true });
  toast(lastStatus?.companion?.ok ? "Companion online" : "Companion offline", lastStatus?.companion?.ok ? "ok" : "bad");
});

$("btnDetectExecutor").addEventListener("click", async () => {
  $("connectHint").textContent = "Probing…";
  const res = await chrome.runtime.sendMessage({
    type: "detectExecutor",
    candidates: LAB_CANDIDATES.concat([$("executorUrl").value.trim()].filter(Boolean)),
  });
  if (res?.ok && res.url) {
    $("executorUrl").value = res.url;
    await chrome.runtime.sendMessage({ type: "saveSecrets", executorUrl: res.url });
    $("connectHint").textContent = `Found · ${res.ms ?? "?"}ms`;
    toast("Executor found");
    await refresh();
    await autoConnect({ quiet: true });
  } else {
    $("connectHint").textContent = res?.error || "Not reachable";
    toast("Not found", "bad");
    await refresh();
  }
});

$("btnTestExecutor").addEventListener("click", async () => {
  const url = $("executorUrl").value.trim();
  if (!url) {
    toast("Enter URL", "bad");
    return;
  }
  await chrome.runtime.sendMessage({ type: "saveSecrets", executorUrl: url });
  const res = await chrome.runtime.sendMessage({ type: "probeExecutor" });
  $("connectHint").textContent = res?.ok
    ? `OK · ${res.ms ?? "?"}ms`
    : res?.error || "Unreachable";
  toast(res?.ok ? "Reachable" : "Failed", res?.ok ? "ok" : "bad");
  await refresh();
});

$("btnDetectTs").addEventListener("click", async () => {
  $("advPanel").open = true;
  let ip = await detectTsWebRtc();
  let source = "webrtc";
  if (!ip) {
    const res = await chrome.runtime.sendMessage({ type: "detectTailscale" });
    if (res?.ok && res.ip) {
      ip = res.ip;
      source = res.source || "bg";
    } else {
      toast(res?.error || "No TS IP", "bad");
      return;
    }
  }
  $("publicEndpoint").value = `http://${ip}:9230/mcp`;
  await chrome.runtime.sendMessage({
    type: "saveSecrets",
    publicEndpoint: `http://${ip}:9230/mcp`,
  });
  toast(`${ip} (${source})`);
  await refresh();
});

$("btnConnect").addEventListener("click", async () => {
  const btn = $("btnConnect");
  btn.disabled = true;
  $("connectHint").textContent = "Connecting…";

  const executorUrl = $("executorUrl").value.trim();
  const executorApiKey = $("executorApiKey").value.trim();
  if (!executorUrl) {
    $("connectHint").textContent = "URL required";
    btn.disabled = false;
    return;
  }
  if (!executorApiKey && !lastStatus?.settings?.hasApiKey) {
    $("connectHint").textContent = "API key required";
    btn.disabled = false;
    return;
  }

  await saveMode();
  const res = await autoConnect({ quiet: false });
  btn.disabled = false;
  if (res?.ok) {
    const form = $("connectForm");
    if (form) delete form.dataset.forceEdit;
    await autoAdvanced({ register: true });
  }
});

$("btnReconnect")?.addEventListener("click", async () => {
  $("connectHint").textContent = "Re-checking…";
  await autoConnect({ quiet: false });
  await autoAdvanced({ register: true });
});

$("btnEditConnection")?.addEventListener("click", () => {
  const form = $("connectForm");
  if (!form) return;
  form.dataset.forceEdit = "1";
  form.classList.remove("is-collapsed");
  if ($("connectActions")) $("connectActions").hidden = false;
  if ($("btnConnect")) {
    $("btnConnect").hidden = false;
    $("btnConnect").textContent = "Save & connect";
  }
  $("executorApiKey")?.focus();
});

$("btnDisconnect")?.addEventListener("click", async () => {
  authOk = false;
  automationOk = false;
  await chrome.runtime.sendMessage({ type: "disconnectExecutor" });
  if ($("executorApiKey")) {
    $("executorApiKey").value = "";
    $("executorApiKey").placeholder = "Personal API key";
  }
  const form = $("connectForm");
  if (form) {
    delete form.dataset.forceEdit;
    form.classList.remove("is-collapsed");
  }
  if ($("btnConnect")) {
    $("btnConnect").textContent = "Connect";
    $("btnConnect").hidden = false;
  }
  if ($("connectActions")) $("connectActions").hidden = false;
  if ($("connectedActions")) $("connectedActions").hidden = true;
  $("connectHint").textContent = "Disconnected — paste key to reconnect";
  toast("Disconnected");
  await refresh();
});

$("btnRegisterAutomation").addEventListener("click", async () => {
  const endpoint = $("publicEndpoint").value.trim();
  if (endpoint) {
    await chrome.runtime.sendMessage({
      type: "saveSecrets",
      publicEndpoint: endpoint,
      executorUrl: $("executorUrl").value.trim() || undefined,
      executorApiKey: $("executorApiKey").value.trim() || undefined,
    });
  }
  $("advancedHint").textContent = "Registering…";
  const res = await chrome.runtime.sendMessage({
    type: "registerExecutor",
    endpoint: endpoint || undefined,
  });
  automationOk = Boolean(res?.ok);
  $("advancedHint").textContent = res?.ok ? "Registered" : res?.error || "Failed";
  toast(res?.ok ? "Registered" : res?.error || "Failed", res?.ok ? "ok" : "bad");
  if (!res?.ok) $("advPanel").open = true;
  await refresh();
});

$("btnClearActivity").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearActivity" });
  await refresh();
});

document.querySelectorAll('input[name="mode"]').forEach((el) => {
  el.addEventListener("change", () => saveMode());
});

// Re-run advanced auto when user expands it
$("advPanel")?.addEventListener("toggle", () => {
  if ($("advPanel").open) autoAdvanced({ register: true });
});

// Auto-connect when user finishes pasting a key
$("executorApiKey")?.addEventListener("change", () => {
  autoConnect({ quiet: false }).then((r) => {
    if (r?.ok) autoAdvanced({ register: true });
  });
});

function buildAgentPrompt(settings) {
  const s = settings || lastStatus?.settings || {};
  const url = s.executorUrl || LAB_CANDIDATES[0];
  const mcp = (url || "").replace(/\/$/, "") + "/mcp";
  const publicMcp =
    s.publicEndpoint ||
    $("publicEndpoint")?.value?.trim() ||
    null;
  const tabN = lastStatus?.tabs?.length || 0;
  const group = s.groupTitle || "Executor";
  const driveOn = Boolean(automationOk || s.chromeRegistered);

  if (driveOn && publicMcp) {
    return [
      "Browser control is ON for this desktop session via Executor.",
      "",
      `Executor MCP: ${mcp}`,
      `Chrome tools address: tools.chrome.user.desktop`,
      `Companion endpoint (already registered): ${publicMcp}`,
      "",
      "How to use:",
      `- Call tools under tools.chrome.user.desktop (navigate, click, type, fill, wait, …).`,
      "- Prefer take_snapshot / a11y tree over screenshots. Do not start performance traces unless asked.",
      `- Prefer the Chrome tab group titled “${group}” for agent work${tabN ? ` (${tabN} tab(s) already open)` : ""}.`,
      "- Keep sessions in normal http(s) pages; chrome:// and extension pages are not controllable.",
      "- If a chrome tool errors or connection is degraded, say so and stop inventing page state.",
      "- Use other Executor tools as needed; browser tools only when the task needs the live page.",
    ].join("\n");
  }

  // Connected for Executor API; remote CDP needs companion (extension can't host MCP in MV3)
  return [
    "Executor is CONNECTED for this user (API key verified).",
    "",
    `Executor MCP: ${mcp}`,
    "Use Executor tools for this session.",
    "",
    "Browser control:",
    "- Remote tools.chrome.* are NOT available — companion MCP is not registered.",
    "- Why: Chrome MV3 extensions cannot expose a streamable MCP port for Executor to call. A small local companion does that.",
    `- The “${group}” tab group + side-panel preview are local UX only (open/group/capture), not agent CDP.`,
    "- If the task needs live click/type/snapshot: user starts companion + Advanced → Register, then re-copy this prompt.",
    "- Otherwise use non-browser Executor tools only. Do not invent page state.",
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
    toast("Copied");
  } catch {
    toast("Copy failed", "bad");
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
  if ($("advancedHint")) $("advancedHint").textContent = "Saved";
  toast("Saved");
  await refresh();
});

// Boot: detect → auto-connect → advanced auto-find
(async () => {
  $("headerStatus").textContent = "Connecting…";
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
    await refresh();
  }

  const s = lastStatus?.settings;
  if ($("healthUrl")) $("healthUrl").value = s?.companionHealthUrl || "http://127.0.0.1:9230/healthz";
  if ($("mcpUrl")) $("mcpUrl").value = s?.companionMcpUrl || "http://127.0.0.1:9230/mcp";
  if ($("groupTitle")) $("groupTitle").value = s?.groupTitle || "Executor";

  // Auto-connect whenever a key is already stored
  if (s?.hasApiKey) {
    await autoConnect({ quiet: true });
  }

  // Below-fold: probe companion / TS / register if possible
  await autoAdvanced({ register: Boolean(authOk) });

  fillAgentPrompt(lastStatus?.settings);
  bootDone = true;
  setTimeout(() => capture({ focus: false }), 400);
})();

setInterval(async () => {
  await refresh();
  // Soft re-auth if we thought we were connected but reach died
  if (lastStatus?.settings?.hasApiKey && !authOk && lastStatus?.executor?.ok) {
    await autoConnect({ quiet: true });
  }
  // Soft re-check companion
  if (authOk) {
    const c = lastStatus?.companion;
    if (c?.ok && !automationOk) await autoAdvanced({ register: true });
  }
}, 15000);

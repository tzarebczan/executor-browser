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
let bootDone = false;

function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

/**
 * Update a signal-rail value + LED (or legacy .stat-value).
 * @param {HTMLElement | null} el
 * @param {string} text
 * @param {"ok"|"bad"|"warn"|""} cls
 */
function setStat(el, text, cls) {
  if (!el) return;
  el.textContent = text;
  const isSig = el.classList.contains("sig-v") || el.closest(".signal");
  el.className = isSig ? `sig-v mono ${cls || ""}`.trim() : `stat-value ${cls || ""}`.trim();
  const signal = el.closest(".signal");
  const led = signal?.querySelector(".led");
  if (led) {
    led.className = "led";
    if (cls === "ok") led.classList.add("live");
    else if (cls === "warn") led.classList.add("warn");
    else if (cls === "bad") led.classList.add("fault");
  }
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
  const executorReach = Boolean(executor?.ok);
  const hasKey = Boolean(settings.hasApiKey);
  const connected = authOk;
  const reverse = status?.reverse || {};
  const driveReady = Boolean(status?.driveReady);
  const tabCount = status?.tabs?.length || 0;
  const reverseReady = reverse.mode === "reverse" && reverse.running && tabCount > 0;
  return {
    settings,
    executor,
    executorReach,
    hasKey,
    connected,
    reverse,
    driveReady,
    reverseReady,
    tabs: tabCount,
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

  if ($("driveModeTag")) {
    $("driveModeTag").textContent = "reverse";
    $("driveModeTag").className =
      f.driveReady || f.reverseReady ? "mx-tag ok-tag" : "mx-tag";
  }

  if ($("connectDriveBlurb")) {
    if (f.reverse?.mode === "reverse") {
      $("connectDriveBlurb").textContent =
        "Reverse session live — agents drive this Chrome via tools.browser.user.desktop.";
    } else if (f.connected) {
      $("connectDriveBlurb").textContent =
        "Auth OK. Reverse channel starts automatically after Connect.";
    } else {
      $("connectDriveBlurb").textContent =
        "Connect with URL + API key. Drive uses the extension reverse bridge only.";
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

  let driveState = "skip";
  let drivePill = "connect first";
  if (f.reverse?.mode === "reverse") {
    driveState = f.driveReady || f.reverseReady ? "ok" : "warn";
    drivePill = f.driveReady || f.reverseReady ? "session live" : "session · need agent tab";
  } else if (f.connected) {
    driveState = "warn";
    drivePill = f.reverse?.mode || "starting…";
  }

  const connectOptRows = [
    matrixRow(driveState, "Reverse", drivePill),
    matrixRow(
      f.reverseReady || f.driveReady ? "ok" : "skip",
      "Extension tools",
      "snapshot · click · type",
    ),
  ].join("");

  renderConnectState(f);

  const coreRows = [
    matrixRow(f.executorReach ? "ok" : "bad", "Executor", reachDetail),
    matrixRow(authState, "API key", authDetail),
    matrixRow(
      f.tabs > 0 ? "ok" : "skip",
      "Agent tabs",
      f.tabs > 0 ? String(f.tabs) : "none yet",
    ),
  ].join("");

  const revMode = f.reverse?.mode || "idle";
  const driveRows = [
    matrixRow(
      revMode === "reverse" ? "ok" : f.connected ? "warn" : "skip",
      "Reverse session",
      revMode === "reverse" ? "live" : revMode,
    ),
    matrixRow(
      f.tabs > 0 ? "ok" : "skip",
      "Group tabs",
      f.tabs > 0 ? String(f.tabs) : "open a tab",
    ),
  ].join("");

  if ($("connectMatrix")) $("connectMatrix").innerHTML = connectRows;
  if ($("connectMatrixOpt")) $("connectMatrixOpt").innerHTML = connectOptRows;
  if ($("agentMatrixCore")) $("agentMatrixCore").innerHTML = coreRows;
  if ($("agentMatrixDrive")) $("agentMatrixDrive").innerHTML = driveRows;

  if ($("useBadge")) {
    if (!f.connected) {
      $("useBadge").textContent = "setup";
      $("useBadge").className = "badge soft";
    } else if (f.driveReady || f.reverseReady) {
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
    if (revMode === "reverse") {
      $("driveBlurb").textContent =
        "Reverse session live — agents use tools.browser.user.desktop (not Capture).";
    } else {
      $("driveBlurb").textContent =
        "Connect starts reverse automatically. Open an agent tab so tools have a target.";
    }
  }

  if ($("nextHint")) {
    if (!f.executorReach) $("nextHint").textContent = "Not connected: Tailscale / Detect.";
    else if (!f.hasKey) $("nextHint").textContent = "Not connected: paste API key.";
    else if (!f.connected) $("nextHint").textContent = "Not connected: auth failed or verifying.";
    else if (revMode === "reverse" && f.tabs === 0)
      $("nextHint").textContent = "Connected — open an agent tab for drive.";
    else if (revMode === "reverse") $("nextHint").textContent = "Connected + reverse browser bridge.";
    else $("nextHint").textContent = "Connected to Executor.";
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
  else if (f.reverse?.mode === "reverse" || f.driveReady) $("headerStatus").textContent = "Connected · reverse";
  else $("headerStatus").textContent = "Connected";
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "getStatus" });
  lastStatus = status;
  const { settings, tabs, activity, executor } = status;
  lastExecutorProbe = executor ?? lastExecutorProbe;

  const executorOk = Boolean(executor?.ok);
  if (executorOk) {
    setStat($("executorStat"), executor.ms != null ? `${executor.ms}ms` : "online", "ok");
  } else {
    setStat($("executorStat"), settings?.executorUrl ? "offline" : "—", "bad");
  }

  // Signal rail: reverse bridge
  const rev = status.reverse || {};
  if (status.driveReady || rev.mode === "reverse") {
    setStat($("companionStat"), "live", "ok");
  } else if (rev.mode === "unsupported") {
    setStat($("companionStat"), "n/a", "warn");
  } else if (authOk) {
    setStat($("companionStat"), rev.mode || "…", "warn");
  } else {
    setStat($("companionStat"), "off", "warn");
  }

  const n = tabs?.length || 0;
  setStat($("tabStat"), String(n), n > 0 ? "ok" : "warn");
  if ($("tabCount")) $("tabCount").textContent = String(n);

  if (document.activeElement?.id !== "executorUrl") {
    $("executorUrl").value = settings.executorUrl || "";
  }
  if (settings.hasApiKey && document.activeElement?.id !== "executorApiKey") {
    $("executorApiKey").placeholder = "•••• saved";
  }
  if ($("groupTitle") && document.activeElement?.id !== "groupTitle" && settings.groupTitle) {
    $("groupTitle").value = settings.groupTitle;
  }
  if ($("groupBadge") && settings.groupTitle) {
    $("groupBadge").textContent = settings.groupTitle;
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
        await capture({ focus: false, soft: true });
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
  if (/invisible|not visible|cannot capture/i.test(s)) {
    return "Tab not visible — bring the agent Chrome window to front, then Capture.";
  }
  if (/MAX_CAPTURE|quota|rate-limited|exceeds/i.test(s)) {
    return "Chrome limits captures to ~1/sec — wait a moment and Capture again.";
  }
  return s.slice(0, 140) || "Capture failed";
}

/** Coalesce rapid Capture clicks + boot/auto soft captures (Chrome quota ~2/s). */
let captureInFlight = null;
let lastSoftCaptureAt = 0;
const SOFT_CAPTURE_COOLDOWN_MS = 2500;

async function capture({ focus = false, soft = false } = {}) {
  if (soft) {
    if (Date.now() - lastSoftCaptureAt < SOFT_CAPTURE_COOLDOWN_MS) return;
    if (captureInFlight) return;
  }
  if (captureInFlight) {
    // User click waits for in-flight; soft skips
    if (soft) return;
    try {
      await captureInFlight;
    } catch {
      /* ignore */
    }
  }

  captureInFlight = (async () => {
    if ($("btnCapture")) $("btnCapture").disabled = true;
    if ($("btnCaptureTabs")) $("btnCaptureTabs").disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: "capturePreview", focus });
      const errEl = $("previewError");
      if (!res?.ok) {
        $("previewEmpty").hidden = false;
        $("previewImg").hidden = true;
        const msg = friendlyCaptureError(res?.error);
        $("previewUrl").textContent = "—";
        $("previewTitle").textContent = "Capture failed";
        $("previewEmptyTitle").textContent = "Capture failed";
        $("previewEmptyHint").textContent = msg;
        errEl.hidden = false;
        errEl.textContent = msg;
        if ($("previewLocalTag")) $("previewLocalTag").hidden = true;
        return;
      }
      errEl.hidden = true;
      $("previewEmpty").hidden = true;
      if ($("previewLocalTag")) $("previewLocalTag").hidden = false;
      const img = $("previewImg");
      img.hidden = false;
      img.src = res.dataUrl;
      $("previewUrl").textContent = res.tab?.url || "";
      $("previewTitle").textContent = res.tab?.title || "Preview";
      if (soft) lastSoftCaptureAt = Date.now();
    } finally {
      if ($("btnCapture")) $("btnCapture").disabled = false;
      if ($("btnCaptureTabs")) $("btnCaptureTabs").disabled = false;
      captureInFlight = null;
    }
  })();
  return captureInFlight;
}

async function openAgentTab() {
  await chrome.runtime.sendMessage({
    type: "openAgentTab",
    url: "https://tbd.jiggytom.com/",
  });
  await refresh();
  setTimeout(() => capture({ focus: false, soft: true }), 1600);
  toast("Opened agent tab");
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
});

$("btnCapture").addEventListener("click", () => capture({ focus: true }));
$("btnCaptureTabs")?.addEventListener("click", () => capture({ focus: true }));
$("btnOpenTab").addEventListener("click", () => openAgentTab());
$("btnOpenTabHome").addEventListener("click", () => openAgentTab());

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

  const res = await autoConnect({ quiet: false });
  btn.disabled = false;
  if (res?.ok) {
    const form = $("connectForm");
    if (form) delete form.dataset.forceEdit;
  }
});

$("btnReconnect")?.addEventListener("click", async () => {
  $("connectHint").textContent = "Re-checking…";
  await autoConnect({ quiet: false });
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

$("btnClearActivity").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearActivity" });
  await refresh();
});

// Auto-connect when user finishes pasting a key
$("executorApiKey")?.addEventListener("change", () => {
  autoConnect({ quiet: false });
});

function buildAgentPrompt(settings) {
  const s = settings || lastStatus?.settings || {};
  const url = s.executorUrl || LAB_CANDIDATES[0];
  const mcp = (url || "").replace(/\/$/, "") + "/mcp";
  const tabN = lastStatus?.tabs?.length || 0;
  const group = s.groupTitle || "Executor";
  const rev = lastStatus?.reverse || {};

  if (rev.mode === "reverse") {
    return [
      "Executor CONNECTED. Browser reverse bridge is enabled.",
      "",
      `Executor MCP: ${mcp}`,
      "Chrome tools: tools.browser.user.desktop (tabs, navigate, snapshot, click, type, screenshot).",
      "Reverse session is live for this extension.",
      "",
      "How to use:",
      "- Prefer snapshot (a11y-ish) over screenshots.",
      `- Only tabs in group “${group}”${tabN ? ` (${tabN} open)` : ""} are controllable.`,
      "- Normal http(s) pages only; not chrome://.",
      "- On tool error, report it — do not invent DOM state.",
    ].join("\n");
  }

  return [
    "Executor is CONNECTED (API key verified).",
    `Executor MCP: ${mcp}`,
    "Use Executor tools for this session.",
    "",
    rev.mode === "unsupported"
      ? "Browser reverse API missing on this Executor — upgrade host browser-bridge."
      : "Browser reverse: reconnect the extension side panel if tools.browser.user.desktop is unavailable.",
    `- Tab group “${group}”${tabN ? ` (${tabN} open)` : ""}.`,
    "Do not invent page state.",
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

$("btnStartDrive")?.addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "startReverseBridge" });
  toast(
    r?.mode === "reverse" ? "Reverse session live" : r?.lastError || "Bridge failed",
    r?.mode === "error" || r?.mode === "unsupported" ? "bad" : "ok",
  );
  await refresh();
});

$("btnPingDrive")?.addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "browserTool", tool: "ping" });
  toast(r?.ok ? `Ping ok · ${r.mode || "tools"}` : r?.error || "Ping failed", r?.ok ? "ok" : "bad");
});

$("btnSaveAdvanced")?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "saveSettings",
    settings: {
      groupTitle: $("groupTitle")?.value.trim() || "Executor",
    },
  });
  if ($("advancedHint")) $("advancedHint").textContent = "Saved";
  toast("Saved");
  await refresh();
});

// Boot: detect → auto-connect
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
  if ($("groupTitle")) $("groupTitle").value = s?.groupTitle || "Executor";

  if (s?.hasApiKey) {
    await autoConnect({ quiet: true });
  }

  fillAgentPrompt(lastStatus?.settings);
  bootDone = true;
  setTimeout(() => capture({ focus: false, soft: true }), 1800);
})();

setInterval(async () => {
  await refresh();
  if (lastStatus?.settings?.hasApiKey && !authOk && lastStatus?.executor?.ok) {
    await autoConnect({ quiet: true });
  }
}, 15000);

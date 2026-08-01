/**
 * Executor Browser — service worker
 *
 * - Side panel + API-key connect (Tailscale)
 * - Path B (default): extension reverse bridge — no local script
 * - Path C (advanced): native messaging host for full CDP
 * - Legacy: companion :9230 register (lab)
 * - Tab group + live preview
 */

import {
  startReverseBridge,
  stopReverseBridge,
  getReverseStatus,
  handleBridgeToolCall,
} from "./lib/reverse-bridge.js";
import {
  connectNative,
  disconnectNative,
  getNativeStatus,
  nativeToolCall,
  NATIVE_HOST_INSTALL,
} from "./lib/native-bridge.js";
import { BROWSER_TOOLS_META } from "./lib/browser-tools.js";

const DEFAULTS = {
  companionHealthUrl: "http://127.0.0.1:9230/healthz",
  companionMcpUrl: "http://127.0.0.1:9230/mcp",
  companionPort: 9230,
  executorUrl: "",
  executorApiKey: "",
  publicEndpoint: "",
  registeredAt: 0,
  /** true after successful companion MCP register with Executor */
  chromeRegistered: false,
  /**
   * Browser drive mode:
   *  reverse — path B (extension-only reverse channel) [default]
   *  native  — path C (native messaging host)
   *  companion — legacy :9230 HTTP register
   *  off — pair only
   */
  driveMode: "reverse",
  mode: "existing", // existing | fresh | extension-only
  tailscaleHint: "",
  groupTitle: "Executor",
  groupColor: "blue",
  activity: [],
};

const GROUP_TITLE = "Executor";

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...settings };
}

async function setSettings(partial) {
  const cur = await getSettings();
  const next = { ...cur, ...partial };
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function pushActivity(entry) {
  const s = await getSettings();
  const activity = [
    { t: Date.now(), ...entry },
    ...(s.activity || []),
  ].slice(0, 40);
  await setSettings({ activity });
  return activity;
}

async function checkCompanion() {
  const s = await getSettings();
  const started = performance.now();
  try {
    const r = await fetch(s.companionHealthUrl, { method: "GET", cache: "no-store" });
    const text = (await r.text()).slice(0, 120);
    const ms = Math.round(performance.now() - started);
    return { ok: r.ok, status: r.status, body: text, ms };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), ms: Math.round(performance.now() - started) };
  }
}

/** Probe companion MCP initialize (proves streamable HTTP is up). */
async function probeCompanionMcp() {
  const s = await getSettings();
  try {
    const r = await fetch(s.companionMcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "executor-browser", version: "0.7.1" },
        },
      }),
    });
    const text = await r.text();
    const ok = r.ok && text.includes("chrome_devtools");
    return { ok, status: r.status, snippet: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function ensureAgentTabGroup(tabIds = []) {
  const s = await getSettings();
  const title = s.groupTitle || GROUP_TITLE;
  const color = s.groupColor || "blue";
  const groups = await chrome.tabGroups.query({ title });
  let groupId = groups[0]?.id;
  if (groupId == null && tabIds.length) {
    groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, {
      title,
      color,
      collapsed: false,
    });
    await pushActivity({ kind: "group", message: `Created tab group “${title}”` });
  } else if (groupId != null && tabIds.length) {
    await chrome.tabs.group({ tabIds, groupId });
  }
  return groupId ?? null;
}

async function listAgentTabs() {
  const s = await getSettings();
  const title = s.groupTitle || GROUP_TITLE;
  const groups = await chrome.tabGroups.query({ title });
  if (!groups.length) return [];
  const groupId = groups[0].id;
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => t.groupId === groupId)
    .map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      active: t.active,
      favIconUrl: t.favIconUrl,
      windowId: t.windowId,
    }));
}

async function openAgentTab(url) {
  const tab = await chrome.tabs.create({
    url: url || "about:blank",
    active: true,
  });
  await ensureAgentTabGroup([tab.id]);
  await pushActivity({ kind: "tab", message: `Opened ${url || "about:blank"}` });
  return tab;
}

/** Chrome enforces MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND (~2/s). Serialize + space calls. */
const CAPTURE_MIN_GAP_MS = 1100;
let lastCaptureVisibleAt = 0;
let captureVisibleChain = Promise.resolve();

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Rate-limited captureVisibleTab shared by preview + (via await) other paths.
 * @param {number} windowId
 * @param {{ format?: string, quality?: number }} opts
 */
async function captureVisibleTabLimited(windowId, opts = { format: "jpeg", quality: 60 }) {
  const run = async () => {
    const wait = Math.max(0, CAPTURE_MIN_GAP_MS - (Date.now() - lastCaptureVisibleAt));
    if (wait > 0) await sleepMs(wait);
    lastCaptureVisibleAt = Date.now();
    return chrome.tabs.captureVisibleTab(windowId, opts);
  };
  const next = captureVisibleChain.then(run, run);
  // Keep chain alive even if this capture fails
  captureVisibleChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Capture the visible tab in a window.
 * Needs host permission <all_urls> (manifest) — activeTab alone is not enough
 * for side-panel auto-refresh without a user gesture.
 *
 * Chrome throws "view is invisible" when the target window is minimized,
 * occluded by the side panel focus, or the tab has not painted yet.
 * Also throws MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND if called too often.
 *
 * @param {{ focus?: boolean }} opts  focus:true steals window focus (user Capture click)
 */
async function capturePreview(opts = {}) {
  const focus = Boolean(opts.focus);
  const agentTabs = await listAgentTabs();
  let tab =
    agentTabs.find((t) => t.active) ||
    agentTabs[0] ||
    null;

  // Side panel steals "last focused window" — prefer a normal browser window
  // that is actually visible (not minimized / not the side-panel host).
  if (!tab) {
    const normals = await chrome.windows.getAll({
      windowTypes: ["normal"],
      populate: false,
    });
    const preferred =
      normals.find((w) => w.focused && w.state !== "minimized") ||
      normals.find((w) => w.state === "normal" || w.state === "maximized") ||
      normals.find((w) => w.state !== "minimized") ||
      normals[0];
    if (preferred?.id != null) {
      const [active] = await chrome.tabs.query({ active: true, windowId: preferred.id });
      if (active && !String(active.url || "").startsWith("chrome://")) {
        tab = {
          id: active.id,
          title: active.title,
          url: active.url,
          windowId: active.windowId,
        };
      }
    }
  }
  if (!tab?.windowId) {
    return {
      ok: false,
      error: "No tab to preview — open a normal page (or an Executor agent tab), then Capture",
    };
  }

  const url = String(tab.url || "");
  if (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("devtools://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:")
  ) {
    return {
      ok: false,
      error: "Can't capture browser chrome pages — switch to a normal http(s) tab",
      tab,
    };
  }

  /** Make window/tab paintable for captureVisibleTab. */
  async function prepareWindow(stealFocus) {
    try {
      const win = await chrome.windows.get(tab.windowId);
      if (win?.state === "minimized") {
        await chrome.windows.update(tab.windowId, { state: "normal" });
        await sleepMs(200);
      }
    } catch {
      /* ignore */
    }
    if (tab.id) {
      const winTabs = await chrome.tabs.query({ windowId: tab.windowId, active: true });
      if (!winTabs.length || winTabs[0].id !== tab.id) {
        await chrome.tabs.update(tab.id, { active: true });
        await sleepMs(180);
      }
    }
    if (stealFocus) {
      await chrome.windows.update(tab.windowId, { focused: true });
      await sleepMs(150);
    }
  }

  try {
    // At most one retry for invisible (rate-limited). Never triple-fire.
    await prepareWindow(focus);
    let dataUrl;
    try {
      dataUrl = await captureVisibleTabLimited(tab.windowId, { format: "jpeg", quality: 60 });
    } catch (first) {
      const m = String(first?.message || first);
      if (/MAX_CAPTURE_VISIBLE_TAB|quota|exceeds/i.test(m)) throw first;
      if (!/invisible|not visible|cannot capture/i.test(m)) throw first;
      await prepareWindow(true);
      // Gap is enforced by captureVisibleTabLimited (~1.1s)
      dataUrl = await captureVisibleTabLimited(tab.windowId, { format: "jpeg", quality: 60 });
    }
    return {
      ok: true,
      dataUrl,
      tab: { id: tab.id, title: tab.title, url: tab.url },
      at: Date.now(),
    };
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("activeTab") || msg.includes("<all_urls>") || msg.includes("permission")) {
      return {
        ok: false,
        error: "Reload the extension on chrome://extensions (permissions), then Capture again",
        tab,
      };
    }
    if (/MAX_CAPTURE_VISIBLE_TAB|quota|exceeds/i.test(msg)) {
      return {
        ok: false,
        error: "Capture rate-limited by Chrome — wait a second and try again",
        tab,
      };
    }
    if (/invisible|not visible|cannot capture/i.test(msg)) {
      return {
        ok: false,
        error:
          "Tab not visible — un-minimize the Chrome window with the agent tab, click it once, then Capture again",
        tab,
      };
    }
    return { ok: false, error: msg, tab };
  }
}

/** Probe Executor HTTPS (no auth) — UI or /api/health. */
async function probeExecutor(baseUrl) {
  const base = (baseUrl || "").replace(/\/$/, "");
  if (!base) return { ok: false, error: "No Executor URL" };
  const started = performance.now();
  for (const path of ["/", "/api/health"]) {
    try {
      const r = await fetch(base + path, { method: "GET", cache: "no-store" });
      const ms = Math.round(performance.now() - started);
      // 401/403 on / still means host is up
      if (r.ok || r.status === 401 || r.status === 403) {
        return { ok: true, status: r.status, ms, url: base, path };
      }
    } catch (e) {
      /* try next path */
    }
  }
  return {
    ok: false,
    error: "Unreachable — join Tailscale or check URL",
    url: base,
    ms: Math.round(performance.now() - started),
  };
}

/** Try candidate base URLs; return first that responds. */
async function detectExecutor(candidates = []) {
  const list = [...candidates].filter(Boolean);
  for (const url of list) {
    const p = await probeExecutor(url);
    if (p.ok) return { ok: true, url: p.url, ms: p.ms, status: p.status };
  }
  return { ok: false, error: "No candidate Executor responded" };
}

/**
 * Verify personal API key: MCP initialize with Bearer.
 * This is the main "Connect" path — no companion required.
 */
async function verifyExecutorAuth() {
  const s = await getSettings();
  if (!s.executorUrl) return { ok: false, error: "Set Executor base URL" };
  if (!s.executorApiKey) return { ok: false, error: "Paste personal API key" };
  const mcpUrl = s.executorUrl.replace(/\/$/, "") + "/mcp";
  try {
    const r = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${s.executorApiKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "executor-browser", version: "0.7.1" },
        },
      }),
    });
    const text = await r.text();
    if (r.status === 401 || r.status === 403) {
      await setSettings({ registeredAt: 0 });
      await stopReverseBridge();
      return { ok: false, error: "Invalid API key (401/403)", status: r.status };
    }
    if (!r.ok) {
      return {
        ok: false,
        error: `MCP initialize failed (${r.status})`,
        detail: text.slice(0, 200),
      };
    }
    await pushActivity({ kind: "executor", message: "API key verified with Executor" });
    // Path B: start reverse bridge automatically after auth
    const settings = await getSettings();
    if ((settings.driveMode || "reverse") === "reverse") {
      startReverseBridge(getSettings, pushActivity).catch(() => {});
    }
    return { ok: true, status: r.status, snippet: text.slice(0, 120) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Unified browser tool entry (B, C, or auto). */
async function runDriveTool(tool, args = {}) {
  const s = await getSettings();
  const drive = s.driveMode || "reverse";
  if (drive === "native") {
    const n = getNativeStatus();
    if (!n.connected) await connectNative();
    if (getNativeStatus().connected) return nativeToolCall(tool, args);
    // fall through to extension tools if host missing
  }
  return handleBridgeToolCall(tool, args);
}

async function ensureDriveForMode() {
  const s = await getSettings();
  const drive = s.driveMode || "reverse";
  if (drive === "reverse" && s.executorApiKey && s.executorUrl) {
    return startReverseBridge(getSettings, pushActivity);
  }
  if (drive === "native") {
    await stopReverseBridge();
    return connectNative();
  }
  if (drive === "off") {
    await stopReverseBridge();
    disconnectNative();
    return { mode: "off" };
  }
  // companion: reverse not required; registration is separate
  await stopReverseBridge();
  return { mode: "companion" };
}

const TS_IP_RE = /100\.\d{1,3}\.\d{1,3}\.\d{1,3}/;

/** WebRTC ICE candidates often include the Tailscale adapter (CGNAT 100.64/10). */
function detectTailscaleViaWebRtc(timeoutMs = 2500) {
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
      const list = [...ips];
      const ts = list.find((ip) => TS_IP_RE.test(ip));
      resolve(ts || null);
    };
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
    } catch {
      resolve(null);
      return;
    }
    pc.createDataChannel("ts");
    pc.onicecandidate = (ev) => {
      const c = ev.candidate?.candidate;
      if (!c) return;
      const m = c.match(
        /([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/,
      );
      if (m) ips.add(m[1]);
    };
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .catch(() => finish());
    setTimeout(finish, timeoutMs);
  });
}

/** Best-effort Tailscale IPv4 — companion meta, then WebRTC, then clear manual hint. */
async function detectTailscale() {
  const s = await getSettings();
  const base = (s.companionHealthUrl || "http://127.0.0.1:9230/healthz").replace(/\/healthz$/, "");
  for (const path of ["/tailscale", "/meta", "/info", "/healthz"]) {
    try {
      const r = await fetch(base + path, { method: "GET", cache: "no-store" });
      if (!r.ok && r.status !== 200) continue;
      const text = await r.text();
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        j = null;
      }
      const ip =
        j?.tailscaleIp ||
        j?.tailscale_ip ||
        j?.ip ||
        j?.tsIp ||
        (text.match(TS_IP_RE) || [])[0];
      if (ip) return { ok: true, ip, source: "companion" };
    } catch {
      /* try next */
    }
  }

  // Service worker may not have RTCPeerConnection on all Chrome builds —
  // UI also runs WebRTC; try here first.
  if (typeof RTCPeerConnection !== "undefined") {
    const ip = await detectTailscaleViaWebRtc();
    if (ip) return { ok: true, ip, source: "webrtc" };
  }

  return {
    ok: false,
    error:
      "Could not auto-detect. Run: tailscale ip -4  →  paste as http://100.x.x.x:9230/mcp  (Executor online ≠ your desktop IP)",
  };
}

/**
 * Register companion with Executor over streamable MCP (self-host API key).
 * Uses execute sandbox to call mcp.addServer + connections.create.
 */
async function registerWithExecutor({ endpoint }) {
  const s = await getSettings();
  if (!s.executorUrl || !s.executorApiKey) {
    return { ok: false, error: "Set Executor URL and API key first" };
  }
  const mcpUrl = s.executorUrl.replace(/\/$/, "") + "/mcp";
  const ep = endpoint || `http://127.0.0.1:${s.companionPort || 9230}/mcp`;

  const headers = {
    authorization: `Bearer ${s.executorApiKey}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };

  const post = async (body, sessionId) => {
    const h = { ...headers };
    if (sessionId) h["Mcp-Session-Id"] = sessionId;
    const r = await fetch(mcpUrl, { method: "POST", headers: h, body: JSON.stringify(body) });
    const text = await r.text();
    const sid = r.headers.get("mcp-session-id") || r.headers.get("Mcp-Session-Id");
    return { ok: r.ok, status: r.status, text, sid };
  };

  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "executor-browser", version: "0.7.1" },
    },
  });
  if (!init.ok) {
    return { ok: false, error: `Executor initialize failed (${init.status})`, detail: init.text.slice(0, 300) };
  }
  const sessionId = init.sid;
  try {
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  } catch {
    /* ignore */
  }

  // Escape for embedding in TS execute string
  const code = `
const endpoint = ${JSON.stringify(ep)};
const probe = await tools.executor.mcp.probeEndpoint({ endpoint, remoteTransport: "streamable-http" });
if (!probe.ok) return { ok: false, stage: "probe", probe };
let add;
try {
  add = await tools.executor.mcp.addServer({
    name: "Chrome (Executor Browser)",
    description: "Registered by Executor Browser extension",
    endpoint,
    remoteTransport: "streamable-http",
    slug: "chrome",
    authenticationTemplate: [{ kind: "none" }],
    auth: { kind: "none" },
  });
} catch (e) {
  add = { err: String(e) };
}
if (add && add.error && String(add.error.message || "").includes("already")) {
  add = { ok: true, data: { slug: "chrome" }, note: "exists" };
}
const conn = await tools.executor.coreTools.connections.create({
  integration: "chrome",
  owner: "user",
  name: "desktop",
  template: "none",
});
return {
  ok: true,
  probe,
  add,
  address: conn?.data?.address || "tools.chrome.user.desktop",
  toolCount: probe.data?.toolCount,
};
`.trim();

  const exec = await post(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "execute", arguments: { code } },
    },
    sessionId,
  );

  // Handle approval pause (resume accept)
  let text = exec.text;
  const idMatch = text.match(/exec_[a-f0-9-]{36}/);
  if (text.includes("waiting_for_interaction") && idMatch) {
    const resume = await post(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "resume",
          arguments: { executionId: idMatch[0], action: "accept", content: "{}" },
        },
      },
      sessionId,
    );
    text = resume.text;
  }

  const success =
    exec.ok &&
    (text.includes('"ok":true') || text.includes("toolCount") || text.includes("tools.chrome"));
  await pushActivity({
    kind: "executor",
    message: success ? "Registered chrome connection with Executor" : "Executor register failed",
  });
  return {
    ok: success,
    status: exec.status,
    raw: text.slice(0, 2000),
  };
}

// Open side panel by default when clicking the extension icon
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Periodic health for badge + reverse bridge keepalive
chrome.alarms.create("companion-health", { periodInMinutes: 1 });
chrome.alarms.create("bridge-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "bridge-keepalive") {
    const s = await getSettings();
    if ((s.driveMode || "reverse") === "reverse" && s.executorApiKey && s.executorUrl) {
      const st = getReverseStatus();
      if (!st.running || st.mode === "idle" || st.mode === "error" || st.mode === "unsupported") {
        startReverseBridge(getSettings, pushActivity).catch(() => {});
      }
    }
    return;
  }
  if (a.name !== "companion-health") return;
  const s = await getSettings();
  const drive = s.driveMode || "reverse";
  let ok = Boolean(s.registeredAt && s.executorApiKey);
  if (drive === "reverse") {
    const st = getReverseStatus();
    ok = ok && st.mode === "reverse" && st.running;
  } else if (drive === "companion") {
    const c = await checkCompanion();
    ok = c.ok;
  } else if (drive === "native") {
    ok = getNativeStatus().connected;
  }
  await chrome.action.setBadgeText({ text: ok ? "" : "!" });
  await chrome.action.setBadgeBackgroundColor({ color: ok ? "#34a853" : "#ea4335" });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "getStatus": {
        const settings = await getSettings();
        const companion = await checkCompanion();
        const tabs = await listAgentTabs();
        const executor = settings.executorUrl
          ? await probeExecutor(settings.executorUrl)
          : { ok: false, error: "no url" };
        const reverse = getReverseStatus();
        const native = getNativeStatus();
        const driveMode = settings.driveMode || "reverse";
        // Browser drive is ready only with a live reverse session, native host, or companion.
        const driveReady =
          (driveMode === "reverse" && reverse.mode === "reverse" && reverse.running) ||
          (driveMode === "native" && native.connected) ||
          (driveMode === "companion" && Boolean(settings.chromeRegistered) && companion.ok);
        sendResponse({
          settings: {
            ...settings,
            executorApiKey: settings.executorApiKey ? "••••••••" : "",
            hasApiKey: Boolean(settings.executorApiKey),
          },
          companion,
          executor,
          reverse,
          native,
          driveReady,
          driveMode,
          browserTools: BROWSER_TOOLS_META,
          tabs,
          activity: settings.activity || [],
        });
        break;
      }
      case "saveSettings": {
        // If UI sent masked key, keep existing
        const patch = { ...msg.settings };
        if (patch.executorApiKey === "••••••••") delete patch.executorApiKey;
        const settings = await setSettings(patch);
        sendResponse({ ok: true, settings: { ...settings, executorApiKey: settings.executorApiKey ? "••••••••" : "", hasApiKey: Boolean(settings.executorApiKey) } });
        break;
      }
      case "saveSecrets": {
        const patch = {
          executorUrl: msg.executorUrl ?? undefined,
          executorApiKey: msg.executorApiKey ?? undefined,
          tailscaleHint: msg.tailscaleHint ?? undefined,
          publicEndpoint: msg.publicEndpoint ?? undefined,
        };
        // drop undefined keys so we don't wipe; allow "" to clear secrets
        for (const k of Object.keys(patch)) {
          if (patch[k] === undefined) delete patch[k];
        }
        const settings = await setSettings(patch);
        sendResponse({ ok: true, hasApiKey: Boolean(settings.executorApiKey) });
        break;
      }
      case "disconnectExecutor": {
        await stopReverseBridge();
        disconnectNative();
        const settings = await setSettings({
          executorApiKey: "",
          registeredAt: 0,
          chromeRegistered: false,
          publicEndpoint: "",
        });
        sendResponse({ ok: true, hasApiKey: Boolean(settings.executorApiKey) });
        break;
      }
      case "setDriveMode": {
        const driveMode = msg.driveMode || "reverse";
        await setSettings({ driveMode });
        const st = await ensureDriveForMode();
        sendResponse({ ok: true, driveMode, status: st });
        break;
      }
      case "startReverseBridge": {
        sendResponse(await startReverseBridge(getSettings, pushActivity));
        break;
      }
      case "stopReverseBridge": {
        await stopReverseBridge();
        sendResponse({ ok: true });
        break;
      }
      case "connectNativeHost": {
        sendResponse(await connectNative());
        break;
      }
      case "nativeHostInfo": {
        sendResponse({ ok: true, ...NATIVE_HOST_INSTALL, status: getNativeStatus() });
        break;
      }
      case "browserTool": {
        sendResponse(await runDriveTool(msg.tool, msg.args || {}));
        break;
      }
      case "detectTailscale":
        sendResponse(await detectTailscale());
        break;
      case "probeExecutor": {
        const s = await getSettings();
        sendResponse(await probeExecutor(msg.url || s.executorUrl));
        break;
      }
      case "detectExecutor":
        sendResponse(await detectExecutor(msg.candidates || []));
        break;
      case "verifyExecutorAuth":
        sendResponse(await verifyExecutorAuth());
        break;
      case "checkCompanion":
        sendResponse(await checkCompanion());
        break;
      case "probeMcp":
        sendResponse(await probeCompanionMcp());
        break;
      case "openAgentTab":
        sendResponse({ ok: true, tab: await openAgentTab(msg.url) });
        break;
      case "ensureGroup":
        sendResponse({ ok: true, groupId: await ensureAgentTabGroup(msg.tabIds || []) });
        break;
      case "listAgentTabs":
        sendResponse({ ok: true, tabs: await listAgentTabs() });
        break;
      case "capturePreview":
        sendResponse(await capturePreview({ focus: Boolean(msg.focus) }));
        break;
      case "registerExecutor": {
        const ep = msg.endpoint || (await getSettings()).publicEndpoint;
        const result = await registerWithExecutor({ endpoint: ep });
        if (result.ok) {
          await setSettings({
            registeredAt: Date.now(),
            chromeRegistered: true,
            publicEndpoint: ep || (await getSettings()).publicEndpoint,
          });
        }
        sendResponse(result);
        break;
      }
      case "pushActivity":
        sendResponse({ ok: true, activity: await pushActivity(msg.entry || {}) });
        break;
      case "clearActivity":
        await setSettings({ activity: [] });
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: "unknown message type" });
    }
  })().catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

// Boot: if already connected, bring up reverse bridge
(async () => {
  const s = await getSettings();
  if (s.executorApiKey && s.executorUrl && (s.driveMode || "reverse") === "reverse") {
    startReverseBridge(getSettings, pushActivity).catch(() => {});
  }
})();

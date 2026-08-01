/**
 * Executor Browser — service worker
 *
 * - Side panel opens by default on action click
 * - Tab group "Executor" for agent-owned tabs
 * - Companion health (localhost:9230)
 * - Optional Executor MCP registration (API key + Tailscale URL)
 * - Live preview via captureVisibleTab for the active agent-group tab
 */

const DEFAULTS = {
  companionHealthUrl: "http://127.0.0.1:9230/healthz",
  companionMcpUrl: "http://127.0.0.1:9230/mcp",
  companionPort: 9230,
  executorUrl: "",
  executorApiKey: "",
  pairToken: "",
  publicEndpoint: "",
  registeredAt: 0,
  /** true after successful companion MCP register with Executor */
  chromeRegistered: false,
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
          clientInfo: { name: "executor-browser", version: "0.1.0" },
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

/**
 * Capture the visible tab in a window.
 * Needs host permission <all_urls> (manifest) — activeTab alone is not enough
 * for side-panel auto-refresh without a user gesture.
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

  // Side panel steals "last focused window" — prefer a normal browser window.
  if (!tab) {
    const normals = await chrome.windows.getAll({
      windowTypes: ["normal"],
      populate: false,
    });
    const preferred =
      normals.find((w) => w.focused) ||
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

  try {
    // Capture needs the tab active in its window. Prefer not stealing OS focus
    // unless the user clicked Capture (focus:true).
    if (tab.id) {
      const winTabs = await chrome.tabs.query({ windowId: tab.windowId, active: true });
      if (!winTabs.length || winTabs[0].id !== tab.id) {
        await chrome.tabs.update(tab.id, { active: true });
        await new Promise((r) => setTimeout(r, 120));
      }
    }
    if (focus) {
      await chrome.windows.update(tab.windowId, { focused: true });
      await new Promise((r) => setTimeout(r, 80));
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 60,
    });
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
          clientInfo: { name: "executor-browser", version: "0.4.0" },
        },
      }),
    });
    const text = await r.text();
    if (r.status === 401 || r.status === 403) {
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
    return { ok: true, status: r.status, snippet: text.slice(0, 120) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
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
      clientInfo: { name: "executor-browser", version: "0.1.0" },
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

// Periodic health for badge
chrome.alarms.create("companion-health", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "companion-health") return;
  const c = await checkCompanion();
  await chrome.action.setBadgeText({ text: c.ok ? "" : "!" });
  await chrome.action.setBadgeBackgroundColor({ color: c.ok ? "#34a853" : "#ea4335" });
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
        sendResponse({
          settings: {
            ...settings,
            // never echo full API key to UI logs; mask in status
            executorApiKey: settings.executorApiKey ? "••••••••" : "",
            hasApiKey: Boolean(settings.executorApiKey),
          },
          companion,
          executor,
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
        const settings = await setSettings({
          executorApiKey: "",
          registeredAt: 0,
          chromeRegistered: false,
          publicEndpoint: "",
        });
        sendResponse({ ok: true, hasApiKey: Boolean(settings.executorApiKey) });
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

// External pair from product web
chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "pairFromWeb") {
    setSettings({
      pairToken: msg.pairToken || "",
      executorUrl: msg.executorUrl || "",
      pairedAt: Date.now(),
    }).then(async () => {
      await pushActivity({ kind: "pair", message: "Paired from web" });
      sendResponse({ ok: true });
    });
    return true;
  }
});

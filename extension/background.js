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

async function capturePreview() {
  const agentTabs = await listAgentTabs();
  let tab =
    agentTabs.find((t) => t.active) ||
    agentTabs[0] ||
    null;

  // Fall back to current window active tab
  if (!tab) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active) {
      tab = {
        id: active.id,
        title: active.title,
        url: active.url,
        windowId: active.windowId,
      };
    }
  }
  if (!tab?.windowId) {
    return { ok: false, error: "No tab to preview" };
  }

  try {
    // Focus that window/tab so capture is meaningful
    await chrome.windows.update(tab.windowId, { focused: true });
    if (tab.id) await chrome.tabs.update(tab.id, { active: true });
    await new Promise((r) => setTimeout(r, 120));
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 55,
    });
    return {
      ok: true,
      dataUrl,
      tab: { id: tab.id, title: tab.title, url: tab.url },
      at: Date.now(),
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), tab };
  }
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
        sendResponse({
          settings: {
            ...settings,
            // never echo full API key to UI logs; mask in status
            executorApiKey: settings.executorApiKey ? "••••••••" : "",
            hasApiKey: Boolean(settings.executorApiKey),
          },
          companion,
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
        const settings = await setSettings({
          executorUrl: msg.executorUrl ?? undefined,
          executorApiKey: msg.executorApiKey ?? undefined,
          tailscaleHint: msg.tailscaleHint ?? undefined,
        });
        sendResponse({ ok: true, hasApiKey: Boolean(settings.executorApiKey) });
        break;
      }
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
        sendResponse(await capturePreview());
        break;
      case "registerExecutor":
        sendResponse(await registerWithExecutor({ endpoint: msg.endpoint }));
        break;
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

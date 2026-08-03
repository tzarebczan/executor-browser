/**
 * Executor Browser — service worker
 *
 * - Side panel + API-key connect (Tailscale)
 * - Reverse bridge (extension → Executor long-poll) — default and only drive path
 * - Tab group + local preview capture
 */

import {
  startReverseBridge,
  stopReverseBridge,
  getReverseStatus,
  handleBridgeToolCall,
} from "./lib/reverse-bridge.js";
import {
  BROWSER_TOOLS_META,
  ensureAgentTabGroup,
  listAgentTabs,
} from "./lib/browser-tools.js";

const DEFAULTS = {
  executorUrl: "",
  executorApiKey: "",
  registeredAt: 0,
  mode: "existing", // existing | extension-only (UI preference only)
  groupTitle: "Executor",
  groupColor: "blue",
  activity: [],
};

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
 * Rate-limited captureVisibleTab.
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
  captureVisibleChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Capture an Executor-group tab for local UI preview only.
 * @param {{ focus?: boolean }} opts
 */
async function capturePreview(opts = {}) {
  const focus = Boolean(opts.focus);
  const agentTabs = await listAgentTabs();
  let tab =
    agentTabs.find((t) => t.active) ||
    agentTabs[0] ||
    null;

  if (!tab?.windowId) {
    return {
      ok: false,
      error: "No controllable Executor tab. Open or add a tab to the Executor group first.",
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
    await prepareWindow(focus);
    let dataUrl;
    try {
      dataUrl = await captureVisibleTabLimited(tab.windowId, { format: "jpeg", quality: 60 });
    } catch (first) {
      const m = String(first?.message || first);
      if (/MAX_CAPTURE_VISIBLE_TAB|quota|exceeds/i.test(m)) throw first;
      if (!/invisible|not visible|cannot capture/i.test(m)) throw first;
      await prepareWindow(true);
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
      if (r.ok || r.status === 401 || r.status === 403) {
        return { ok: true, status: r.status, ms, url: base, path };
      }
    } catch {
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
 * Starts reverse bridge on success.
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
          clientInfo: { name: "executor-browser", version: "0.8.0" },
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
    await setSettings({ registeredAt: Date.now() });
    await pushActivity({ kind: "executor", message: "API key verified with Executor" });
    startReverseBridge(getSettings, pushActivity).catch(() => {});
    return { ok: true, status: r.status, snippet: text.slice(0, 120) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.alarms.create("bridge-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "bridge-keepalive") return;
  const s = await getSettings();
  if (s.executorApiKey && s.executorUrl) {
    const st = getReverseStatus();
    if (!st.running || st.mode === "idle" || st.mode === "error" || st.mode === "unsupported") {
      startReverseBridge(getSettings, pushActivity).catch(() => {});
    }
  }
  const ok = Boolean(s.executorApiKey && s.executorUrl) && getReverseStatus().mode === "reverse";
  await chrome.action.setBadgeText({ text: ok ? "" : "!" });
  await chrome.action.setBadgeBackgroundColor({ color: ok ? "#34a853" : "#ea4335" });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "getStatus": {
        const settings = await getSettings();
        const tabs = await listAgentTabs();
        const executor = settings.executorUrl
          ? await probeExecutor(settings.executorUrl)
          : { ok: false, error: "no url" };
        const reverse = getReverseStatus();
        const driveReady =
          reverse.mode === "reverse" && reverse.running && tabs.length > 0;
        sendResponse({
          settings: {
            ...settings,
            executorApiKey: settings.executorApiKey ? "••••••••" : "",
            hasApiKey: Boolean(settings.executorApiKey),
          },
          executor,
          reverse,
          driveReady,
          driveMode: "reverse",
          browserTools: BROWSER_TOOLS_META,
          tabs,
          activity: settings.activity || [],
        });
        break;
      }
      case "saveSettings": {
        const patch = { ...msg.settings };
        if (patch.executorApiKey === "••••••••") delete patch.executorApiKey;
        // Drop legacy keys if UI ever sends them
        delete patch.companionHealthUrl;
        delete patch.companionMcpUrl;
        delete patch.companionPort;
        delete patch.publicEndpoint;
        delete patch.chromeRegistered;
        delete patch.driveMode;
        delete patch.tailscaleHint;
        const settings = await setSettings(patch);
        sendResponse({
          ok: true,
          settings: {
            ...settings,
            executorApiKey: settings.executorApiKey ? "••••••••" : "",
            hasApiKey: Boolean(settings.executorApiKey),
          },
        });
        break;
      }
      case "saveSecrets": {
        const patch = {
          executorUrl: msg.executorUrl ?? undefined,
          executorApiKey: msg.executorApiKey ?? undefined,
        };
        for (const k of Object.keys(patch)) {
          if (patch[k] === undefined) delete patch[k];
        }
        const settings = await setSettings(patch);
        sendResponse({ ok: true, hasApiKey: Boolean(settings.executorApiKey) });
        break;
      }
      case "disconnectExecutor": {
        await stopReverseBridge();
        const settings = await setSettings({
          executorApiKey: "",
          registeredAt: 0,
        });
        sendResponse({ ok: true, hasApiKey: Boolean(settings.executorApiKey) });
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
      case "browserTool": {
        sendResponse(await handleBridgeToolCall(msg.tool, msg.args || {}));
        break;
      }
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

(async () => {
  const s = await getSettings();
  if (s.executorApiKey && s.executorUrl) {
    startReverseBridge(getSettings, pushActivity).catch(() => {});
  }
})();

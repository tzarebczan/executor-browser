/**
 * Executor Browser, service worker
 *
 * - Side panel + API-key connect (Tailscale)
 * - Reverse bridge (extension → Executor long-poll), default and only drive path
 * - Tab group + local preview capture
 */

import {
  startReverseBridge,
  stopReverseBridge,
  getReverseStatus,
  handleBridgeToolCall,
  refreshAdvertisedAccess,
  clientInfo,
} from "./lib/reverse-bridge.js";
import {
  BROWSER_TOOLS_META,
  ensureAgentTabGroup,
  listAgentTabs,
} from "./lib/browser-tools.js";
import {
  accessAdvertisement,
  endControlSession,
  getAccessState,
  startControlSession,
} from "./lib/access-policy.js";
import {
  candidatesFromTabs,
  detectExecutor,
  expandUserInput,
  localCandidates,
  probeExecutor,
} from "./lib/discovery.js";
import {
  clearActivity,
  getActivity,
  getSettings,
  pushActivity,
  removeActivityEntry,
  setSettings,
} from "./lib/settings-store.js";

let indicatorRevision = 0;
let indicatorTimer = null;

async function updateOwnedGroup(active) {
  const [settings, tabs] = await Promise.all([getSettings(), listAgentTabs()]);
  const groupId = tabs.find((tab) => Number.isInteger(tab.groupId))?.groupId;
  if (!Number.isInteger(groupId)) return;
  try {
    await chrome.tabGroups.update(groupId, {
      title: active ? `${settings.groupTitle || "Executor"} [ACTIVE]` : settings.groupTitle || "Executor",
      color: active ? "yellow" : settings.groupColor || "blue",
      collapsed: false,
    });
  } catch {
    /* Group may disappear while an operation is finishing. */
  }
}

/**
 * Status is a dot on the mark, not a badge over it.
 *
 * Chrome paints badge text as a rounded rectangle across the bottom of the
 * icon, which at 16px is most of the icon, so "ON" / "!" / "USE" hid the logo
 * exactly when the extension had something to report. Each state is a
 * pre-rendered variant of the mark with a small coloured dot in the corner
 * instead (see design/make-icons.py), and the badge is left empty.
 *
 * @param {"off"|"error"|"live"|"active"} state
 */
async function paintIcon(state) {
  await chrome.action.setIcon({
    path: { 16: `icons/icon16-${state}.png`, 48: `icons/icon48-${state}.png` },
  });
}

/** What the icon should say when no agent is mid-operation. */
async function restingState() {
  if (getReverseStatus().mode === "reverse") return "live";
  const settings = await getSettings();
  // Nothing configured yet is not a fault. Only a browser that was set up and
  // then lost its channel has something wrong with it.
  return settings.executorUrl && settings.executorApiKey ? "error" : "off";
}

const RESTING_TITLES = {
  live: "Executor Browser, agents can control this browser",
  error: "Executor Browser, set up, but not connected",
  off: "Executor Browser, not set up yet",
};

async function setReadyIndicators() {
  const state = await restingState();
  await chrome.action.setBadgeText({ text: "" });
  await paintIcon(state);
  await chrome.action.setTitle({ title: RESTING_TITLES[state] });
  await updateOwnedGroup(false);
}

async function setUseIndicators(state) {
  if (state.active) {
    indicatorRevision += 1;
    if (indicatorTimer) clearTimeout(indicatorTimer);
    await chrome.action.setBadgeText({ text: "" });
    await paintIcon("active");
    await chrome.action.setTitle({
      title: `Executor Browser, ${state.actor || "an agent"} is using ${state.tool || "the browser"}`,
    });
    await updateOwnedGroup(true);
    return;
  }

  const revision = ++indicatorRevision;
  if (indicatorTimer) clearTimeout(indicatorTimer);
  indicatorTimer = setTimeout(() => {
    if (indicatorRevision === revision) setReadyIndicators().catch(() => {});
  }, 1800);
}

/** Keep the last few addresses that really were Executor, most recent first. */
const REMEMBERED_LIMIT = 5;

async function rememberExecutorUrl(url) {
  if (!url) return;
  const settings = await getSettings();
  const previous = Array.isArray(settings.knownExecutorUrls) ? settings.knownExecutorUrls : [];
  const next = [url, ...previous.filter((known) => known !== url)].slice(0, REMEMBERED_LIMIT);
  if (next.length === previous.length && next.every((value, i) => value === previous[i])) return;
  await setSettings({ knownExecutorUrls: next });
}

/**
 * Where to look for Executor, best bet first.
 *
 * Detect used to try two hard-coded localhost URLs, which cannot find a tailnet
 * deployment, a MagicDNS name is per-tailnet and unguessable. These four
 * sources between them cover how people actually run it, and order matters
 * because the first match wins:
 *
 *  1. Whatever the user typed, expanded (a bare `workshop` resolves on a
 *     tailnet, and people paste hostnames without a scheme).
 *  2. Addresses that were Executor before, the "it worked yesterday" case.
 *  3. Private-space origins from open tabs. Anyone who made an API key has had
 *     the console open, so their own tabs are the one reliable source for an
 *     address we could never guess.
 *  4. A sweep of local ports, for a same-machine install.
 */
async function detectionCandidates(fromCaller = []) {
  const settings = await getSettings();
  const typed = fromCaller.flatMap((value) => expandUserInput(value));
  const remembered = Array.isArray(settings.knownExecutorUrls) ? settings.knownExecutorUrls : [];
  const saved = settings.executorUrl ? [settings.executorUrl] : [];

  let fromTabs = [];
  try {
    const tabs = await chrome.tabs.query({});
    fromTabs = candidatesFromTabs(tabs.map((tab) => tab.url));
  } catch {
    // Tab access can be refused; the other sources still stand.
  }

  return [...typed, ...saved, ...remembered, ...fromTabs, ...localCandidates()];
}

function startBridge() {
  return startReverseBridge(getSettings, pushActivity, setUseIndicators).then((status) => {
    setReadyIndicators().catch(() => {});
    return status;
  });
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
      error: "Can't capture browser chrome pages, switch to a normal http(s) tab",
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
        error: "Capture rate-limited by Chrome, wait a second and try again",
        tab,
      };
    }
    if (/invisible|not visible|cannot capture/i.test(msg)) {
      return {
        ok: false,
        error:
          "Tab not visible, un-minimize the Chrome window with the agent tab, click it once, then Capture again",
        tab,
      };
    }
    return { ok: false, error: msg, tab };
  }
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
          clientInfo: clientInfo(),
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
    startBridge().catch(() => {});
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
      startBridge().catch(() => {});
    }
  }
  // One place decides what the icon shows; the keepalive only asks for a repaint.
  await setReadyIndicators();
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
          browserTools: { ...BROWSER_TOOLS_META, access: await accessAdvertisement() },
          controlSession: (await getAccessState()).session,
          tabs,
          activity: await getActivity(),
        });
        break;
      }
      case "saveSettings": {
        const patch = { ...msg.settings };
        const current = await getSettings();
        const accessChanged = ["accessMode", "allowedHosts", "advancedMode", "cdpMode", "sessionMinutes"].some(
          (key) =>
            Object.hasOwn(patch, key) && JSON.stringify(patch[key]) !== JSON.stringify(current[key]),
        );
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
        // Re-advertise rather than reconnect: the new limits are enforced here
        // regardless, and dropping the long-poll to tell Executor about them
        // interrupts any work in flight.
        if (accessChanged) await refreshAdvertisedAccess(getSettings);
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
        await setReadyIndicators();
        sendResponse({ ok: true, hasApiKey: Boolean(settings.executorApiKey) });
        break;
      }
      case "startReverseBridge": {
        sendResponse(await startBridge());
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
        const probe = await probeExecutor(msg.url || s.executorUrl);
        if (probe.ok) await rememberExecutorUrl(probe.url);
        sendResponse(probe);
        break;
      }
      case "detectExecutor": {
        const found = await detectExecutor(await detectionCandidates(msg.candidates || []));
        if (found.ok) await rememberExecutorUrl(found.url);
        sendResponse(found);
        break;
      }
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
        await clearActivity();
        sendResponse({ ok: true });
        break;
      case "startControlSession": {
        const session = await startControlSession("User");
        await pushActivity({ kind: "session", message: `${session.mode === "full" ? "All Chrome tabs" : "Executor tabs"} access window started` });
        // Starting a session widens what is permitted, including Advanced.
        await refreshAdvertisedAccess(getSettings);
        sendResponse({ ok: true, session });
        break;
      }
      case "endControlSession":
        await endControlSession();
        await pushActivity({ kind: "session", message: "Control session ended" });
        await refreshAdvertisedAccess(getSettings);
        sendResponse({ ok: true });
        break;
      case "removeActivity": {
        sendResponse({ ok: true, activity: await removeActivityEntry(msg.id) });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message type" });
    }
  })().catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

(async () => {
  const s = await getSettings();
  if (s.executorApiKey && s.executorUrl) {
    startBridge().catch(() => {});
  } else {
    setReadyIndicators().catch(() => {});
  }
})();

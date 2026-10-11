/**
 * Path B, extension reverse channel to Executor.
 *
 * Extension dials OUT (same trust model as API key). Executor pushes tool jobs
 * over long-poll or WebSocket when the server supports it.
 *
 * Protocol (Executor should implement; client degrades gracefully):
 *   POST  {base}/api/browser-bridge/session     → { sessionId, pollPath?, wsPath? }
 *   GET   {base}/api/browser-bridge/session/:id/jobs?waitMs=25000
 *   POST  {base}/api/browser-bridge/session/:id/result
 *   DELETE {base}/api/browser-bridge/session/:id
 *
 * Local extension pages may also invoke the same dispatcher via chrome.runtime messages.
 */

import { runBrowserTool, BROWSER_TOOLS_META } from "./browser-tools.js";
import { browserActivityEntry, displayActor } from "./activity.js";
import { accessAdvertisement } from "./access-policy.js";
import { localToolAddress, reverseClientIdentity } from "./browser-identity.js";
import { setSettings } from "./settings-store.js";

let running = false;
let sessionId = null;
let lastError = null;
let lastOkAt = 0;
let mode = "idle"; // idle | reverse | polling | unsupported | error
let abort = null;
let runGeneration = 0;
let activeUse = null;
let lastUse = null;
/** JSON of the access scope Executor was last told about, so the poll can tell when it moved. */
let advertisedAccess = null;
/** Catalog connection Executor assigned for this instance. */
let assignedConnection = null;
let assignedBrowser = null;

function baseUrl(settings) {
  return (settings.executorUrl || "").replace(/\/$/, "");
}

/**
 * Identify this extension to Executor.
 *
 * The version is read from the manifest rather than written out here, because
 * a literal drifts: the MCP handshake and the reverse session had already
 * disagreed about which version was running.
 */
export function clientInfo() {
  return { name: "executor-browser", version: chrome.runtime.getManifest().version };
}

async function authHeaders(settings) {
  const h = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (settings.executorApiKey) {
    h.authorization = `Bearer ${settings.executorApiKey}`;
  }
  return h;
}

export function getReverseStatus() {
  return {
    running,
    sessionId,
    mode,
    lastError,
    lastOkAt,
    tools: BROWSER_TOOLS_META.tools,
    transport: "extension-reverse",
    activeUse,
    lastUse,
    connection: assignedConnection,
    address: assignedConnection ? localToolAddress(assignedConnection) : null,
    browser: assignedBrowser,
  };
}

/**
 * Re-send what this extension will currently let through.
 *
 * Capabilities are advertised when the session opens, but access mode, the
 * host allowlist, and the control session all change while it stays open.
 * Executor shows this scope to the user, so a stale advertisement is worse
 * than none, it describes rules that are no longer the ones being enforced.
 *
 * Best-effort by design: a failure here must never disturb the poll loop, and
 * the next reconnect re-advertises anyway.
 */
export async function refreshAdvertisedAccess(getSettings) {
  if (!sessionId || mode !== "reverse") return false;
  try {
    const settings = await getSettings();
    const base = baseUrl(settings);
    if (!base) return false;
    const access = await accessAdvertisement();
    const r = await fetch(`${base}/api/browser-bridge/session/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: await authHeaders(settings),
      body: JSON.stringify({ capabilities: { ...BROWSER_TOOLS_META, access } }),
    });
    if (r.ok) advertisedAccess = JSON.stringify(access);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Re-advertise only when the scope has actually moved.
 *
 * Control sessions expire on a timer, so there is no start/stop call to hang a
 * refresh off, the panel simply starts refusing Advanced work while Executor
 * still shows the session as running. Called on every poll, so the two agree
 * within one poll interval at worst, and sends nothing when nothing changed.
 */
async function reconcileAdvertisedAccess(getSettings) {
  try {
    const next = JSON.stringify(await accessAdvertisement());
    if (next === advertisedAccess) return false;
    return await refreshAdvertisedAccess(getSettings);
  } catch {
    return false;
  }
}

export async function stopReverseBridge() {
  runGeneration += 1;
  running = false;
  activeUse = null;
  if (abort) {
    try {
      abort.abort();
    } catch {
      /* ignore */
    }
    abort = null;
  }
  sessionId = null;
  mode = "idle";
  advertisedAccess = null;
  assignedConnection = null;
  assignedBrowser = null;
}

/**
 * Register reverse session + poll loop.
 * @param {() => Promise<object>} getSettings
 * @param {(entry: object) => Promise<void>} pushActivity
 */
export async function startReverseBridge(getSettings, pushActivity, onUseState) {
  if (running) return getReverseStatus();
  const generation = ++runGeneration;
  running = true;
  const controller = new AbortController();
  abort = controller;
  mode = "polling";
  lastError = null;

  const settings = await getSettings();
  const base = baseUrl(settings);
  if (!base || !settings.executorApiKey) {
    mode = "error";
    lastError = "Need Executor URL + API key";
    running = false;
    return getReverseStatus();
  }

  // 1) Open session
  try {
    const access = await accessAdvertisement();
    const identity = await reverseClientIdentity(settings);
    assignedBrowser = identity.browser;
    const r = await fetch(`${base}/api/browser-bridge/session`, {
      method: "POST",
      headers: await authHeaders(settings),
      signal: controller.signal,
      body: JSON.stringify({
        kind: "chrome-extension",
        transport: "reverse-longpoll",
        client: identity.client,
        capabilities: { ...BROWSER_TOOLS_META, access },
        connection: identity.connection,
      }),
    });
    // Remember what we just said, so the first poll does not re-send it.
    advertisedAccess = JSON.stringify(access);

    if (r.status === 404 || r.status === 501) {
      mode = "unsupported";
      lastError =
        "This Executor cannot accept browser control yet; the extension is ready and waiting on the server";
      await pushActivity?.({
        kind: "bridge",
        message: "Agent control unavailable on this Executor",
      });
      running = false;
      return getReverseStatus();
    }

    if (!r.ok) {
      const t = await r.text();
      mode = "error";
      lastError = `session ${r.status}: ${t.slice(0, 120)}`;
      running = false;
      return getReverseStatus();
    }

    const j = await r.json();
    sessionId = j.sessionId || j.id || j.session_id;
    if (!sessionId) {
      mode = "error";
      lastError = "No sessionId in response";
      running = false;
      return getReverseStatus();
    }

    assignedConnection = typeof j.connection === "string" && j.connection
      ? j.connection
      : identity.connectionName;
    if (assignedConnection && assignedConnection !== settings.connectionName) {
      await setSettings({ connectionName: assignedConnection });
    }

    mode = "reverse";
    lastOkAt = Date.now();
    await pushActivity?.({
      kind: "bridge",
      message: "Agent control connected",
    });
  } catch (e) {
    if (controller.signal.aborted || generation !== runGeneration) return getReverseStatus();
    mode = "error";
    running = false;
    lastError = String(e?.message || e);
    await pushActivity?.({
      kind: "bridge",
      message: "Could not open agent control; retrying shortly",
    });
  }

  // 2) Poll loop (only if we have a server session)
  if (sessionId && mode === "reverse") {
    pollLoop(getSettings, pushActivity, onUseState, generation, sessionId, controller).catch(() => {});
  }

  return getReverseStatus();
}

async function pollLoop(getSettings, pushActivity, onUseState, generation, pollSessionId, controller) {
  while (running && generation === runGeneration) {
    try {
      const settings = await getSettings();
      const base = baseUrl(settings);
      const r = await fetch(
        `${base}/api/browser-bridge/session/${encodeURIComponent(pollSessionId)}/jobs?waitMs=25000`,
        {
          method: "GET",
          headers: await authHeaders(settings),
          signal: controller.signal,
        },
      );

      if (r.status === 401 || r.status === 403) {
        mode = "error";
        lastError = "Auth failed on poll";
        break;
      }
      if (r.status === 404) {
        mode = "unsupported";
        lastError = "Session expired or bridge removed";
        break;
      }
      if (!r.ok) {
        lastError = `poll ${r.status}`;
        await sleep(2000);
        continue;
      }

      const body = await r.json().catch(() => ({}));
      const jobs = body.jobs || body.items || (body.job ? [body.job] : []);
      lastOkAt = Date.now();

      // A control session can also end by simply running out. Nothing calls
      // start or stop in that case, so the poll reconciles: if what we would
      // advertise now differs from what Executor was last told, tell it.
      await reconcileAdvertisedAccess(getSettings);

      for (const job of jobs) {
        const id = job.id || job.jobId;
        const tool = job.tool || job.name || job.method;
        const args = job.args || job.arguments || job.params || {};
        const startedAt = Date.now();
        activeUse = {
          startedAt,
          actor: displayActor(job.caller),
          tool,
        };
        await onUseState?.({ active: true, ...activeUse });
        let result;
        try {
          result = await runBrowserTool(tool, args);
        } catch (e) {
          result = { ok: false, error: String(e?.message || e) };
        }
        let deliveryError = null;
        try {
          await postResult(settings, id, result, pollSessionId);
        } catch (error) {
          deliveryError = error;
        }
        if (deliveryError) {
          result = { ok: false, error: `Could not return result: ${String(deliveryError?.message || deliveryError)}` };
        }
        const entry = browserActivityEntry(job, result, startedAt);
        lastUse = entry;
        activeUse = null;
        await pushActivity?.(entry);
        await onUseState?.({ active: false, entry });
        if (deliveryError) throw deliveryError;
      }
    } catch (e) {
      if (controller.signal.aborted || !running || generation !== runGeneration) break;
      lastError = String(e?.message || e);
      await sleep(3000);
    }
  }
  if (generation === runGeneration) {
    running = false;
    if (mode === "reverse") mode = "idle";
  }
}

async function postResult(settings, jobId, result, resultSessionId = sessionId) {
  if (!resultSessionId || !jobId) return;
  const base = baseUrl(settings);
  const payload = { ...result };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(
        `${base}/api/browser-bridge/session/${encodeURIComponent(resultSessionId)}/result`,
        {
          method: "POST",
          headers: await authHeaders(settings),
          body: JSON.stringify({ jobId, result: payload }),
        },
      );
      if (response.ok) return;
      lastError = `result ${response.status}`;
    } catch (error) {
      lastError = String(error?.message || error);
    }
    if (attempt === 0) await sleep(500);
  }
  throw new Error(lastError || "Could not return browser tool result");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Handle a single tool call (local message / external). */
export async function handleBridgeToolCall(tool, args) {
  return runBrowserTool(tool, args || {});
}

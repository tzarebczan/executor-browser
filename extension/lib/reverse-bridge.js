/**
 * Path B — extension reverse channel to Executor.
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
 * Also accepts jobs via chrome.runtime messages (local / product web).
 */

import { runBrowserTool, BROWSER_TOOLS_META } from "./browser-tools.js";

let running = false;
let sessionId = null;
let lastError = null;
let lastOkAt = 0;
let mode = "idle"; // idle | reverse | polling | unsupported | error
let abort = null;

function baseUrl(settings) {
  return (settings.executorUrl || "").replace(/\/$/, "");
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
  };
}

export async function stopReverseBridge() {
  running = false;
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
}

/**
 * Register reverse session + poll loop.
 * @param {() => Promise<object>} getSettings
 * @param {(entry: object) => Promise<void>} pushActivity
 */
export async function startReverseBridge(getSettings, pushActivity) {
  if (running) return getReverseStatus();
  running = true;
  abort = new AbortController();
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
    const r = await fetch(`${base}/api/browser-bridge/session`, {
      method: "POST",
      headers: await authHeaders(settings),
      signal: abort.signal,
      body: JSON.stringify({
        kind: "chrome-extension",
        transport: "reverse-longpoll",
        client: { name: "executor-browser", version: "0.5.0" },
        capabilities: BROWSER_TOOLS_META,
        connection: { integration: "chrome", name: "desktop", owner: "user" },
      }),
    });

    if (r.status === 404 || r.status === 501) {
      mode = "unsupported";
      lastError =
        "Executor has no browser-bridge API yet — extension tools ready; server path pending";
      await pushActivity?.({
        kind: "bridge",
        message: "Reverse channel: server endpoint missing (tools local-ready)",
      });
      // Stay "running" in local-only accept mode (external messages still work)
      mode = "local-ready";
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

    mode = "reverse";
    lastOkAt = Date.now();
    await pushActivity?.({
      kind: "bridge",
      message: `Reverse bridge session ${String(sessionId).slice(0, 8)}…`,
    });
  } catch (e) {
    if (abort?.signal.aborted) return getReverseStatus();
    mode = "local-ready";
    lastError = String(e?.message || e);
    await pushActivity?.({
      kind: "bridge",
      message: "Reverse session open failed — local tool path only",
    });
  }

  // 2) Poll loop (only if we have a server session)
  if (sessionId && mode === "reverse") {
    pollLoop(getSettings, pushActivity).catch(() => {});
  }

  return getReverseStatus();
}

async function pollLoop(getSettings, pushActivity) {
  while (running && sessionId) {
    try {
      const settings = await getSettings();
      const base = baseUrl(settings);
      const r = await fetch(
        `${base}/api/browser-bridge/session/${encodeURIComponent(sessionId)}/jobs?waitMs=25000`,
        {
          method: "GET",
          headers: await authHeaders(settings),
          signal: abort?.signal,
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

      for (const job of jobs) {
        const id = job.id || job.jobId;
        const tool = job.tool || job.name || job.method;
        const args = job.args || job.arguments || job.params || {};
        let result;
        try {
          result = await runBrowserTool(tool, args);
        } catch (e) {
          result = { ok: false, error: String(e?.message || e) };
        }
        await postResult(settings, id, result);
        await pushActivity?.({
          kind: "bridge",
          message: `${tool} → ${result.ok ? "ok" : "err"}`,
        });
      }
    } catch (e) {
      if (abort?.signal.aborted || !running) break;
      lastError = String(e?.message || e);
      await sleep(3000);
    }
  }
  running = false;
  if (mode === "reverse") mode = "idle";
}

async function postResult(settings, jobId, result) {
  if (!sessionId || !jobId) return;
  const base = baseUrl(settings);
  // Strip huge payloads
  const payload = { ...result };
  delete payload._fullDataUrl;
  if (payload.dataUrl && String(payload.dataUrl).length > 200) {
    payload.dataUrl = String(payload.dataUrl).slice(0, 80) + "…";
  }
  try {
    await fetch(
      `${base}/api/browser-bridge/session/${encodeURIComponent(sessionId)}/result`,
      {
        method: "POST",
        headers: await authHeaders(settings),
        body: JSON.stringify({ jobId, result: payload }),
      },
    );
  } catch {
    /* ignore */
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Handle a single tool call (local message / external). */
export async function handleBridgeToolCall(tool, args) {
  return runBrowserTool(tool, args || {});
}

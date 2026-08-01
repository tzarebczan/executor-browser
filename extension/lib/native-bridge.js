/**
 * Path C — native messaging host (Advanced).
 *
 * Chrome host manifest alone is NOT enough: the JSON only points at a binary
 * Chrome can spawn. Users need that host installed once (or we ship an installer
 * that writes the manifest + binary). No continuous "run a script" after that.
 *
 * Host name: com.executor.browser
 */

const HOST_NAME = "com.executor.browser";

let port = null;
let lastError = null;
let lastPong = 0;
let connected = false;

export function getNativeStatus() {
  return {
    hostName: HOST_NAME,
    connected,
    lastError,
    lastPong,
    // truth in advertising
    needsBinary: true,
    note: "Host manifest registers a local binary; not extension-only",
  };
}

export function disconnectNative() {
  try {
    port?.disconnect();
  } catch {
    /* ignore */
  }
  port = null;
  connected = false;
}

/**
 * Connect to native host. Resolves with status.
 */
export function connectNative() {
  disconnectNative();
  lastError = null;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    lastError = String(e?.message || e);
    connected = false;
    return Promise.resolve(getNativeStatus());
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(getNativeStatus());
    };

    port.onMessage.addListener((msg) => {
      if (msg?.type === "pong" || msg?.ok) {
        connected = true;
        lastPong = Date.now();
        lastError = null;
        done();
      }
      if (msg?.type === "error") {
        lastError = msg.error || "host error";
        connected = false;
        done();
      }
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message;
      if (err) lastError = err;
      // Common: "Specified native messaging host not found"
      if (!connected && !lastError) {
        lastError = "Native host not installed (com.executor.browser)";
      }
      connected = false;
      port = null;
      done();
    });

    try {
      port.postMessage({ type: "ping", ts: Date.now() });
    } catch (e) {
      lastError = String(e?.message || e);
      connected = false;
      done();
      return;
    }

    // Timeout if host never answers
    setTimeout(() => {
      if (!settled) {
        if (!connected) {
          lastError = lastError || "Native host did not respond";
        }
        done();
      }
    }, 2500);
  });
}

/**
 * Ask native host to run a tool (full CDP path when host implements it).
 */
export function nativeToolCall(tool, args = {}) {
  return new Promise((resolve) => {
    if (!port || !connected) {
      resolve({ ok: false, error: "Native host not connected" });
      return;
    }
    const id = `n_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const onMsg = (msg) => {
      if (msg?.id !== id && msg?.replyTo !== id) return;
      port.onMessage.removeListener(onMsg);
      resolve(msg.result || msg);
    };
    port.onMessage.addListener(onMsg);
    try {
      port.postMessage({ type: "tool", id, tool, args });
    } catch (e) {
      port.onMessage.removeListener(onMsg);
      resolve({ ok: false, error: String(e?.message || e) });
    }
    setTimeout(() => {
      port?.onMessage.removeListener(onMsg);
      resolve({ ok: false, error: "Native tool timeout" });
    }, 30000);
  });
}

export const NATIVE_HOST_INSTALL = {
  name: HOST_NAME,
  // Written next to the host binary by installer — not usable alone
  manifestExample: {
    name: HOST_NAME,
    description: "Executor Browser native host (CDP / full tools)",
    path: "EXECUTOR_BROWSER_HOST_PATH",
    type: "stdio",
    allowed_origins: ["chrome-extension://EXTENSION_ID/"],
  },
  windowsReg:
    "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.executor.browser",
  note: "Manifest JSON must reference a real executable. Extension cannot register this without an installer or one-time elevated setup.",
};

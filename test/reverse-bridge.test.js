import assert from "node:assert/strict";
import { test } from "node:test";

const memory = {};

globalThis.chrome = {
  runtime: {
    getManifest() {
      return { version: "0.12.1" };
    },
  },
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: memory[key] };
        if (Array.isArray(key)) {
          const out = {};
          for (const name of key) if (name in memory) out[name] = memory[name];
          return out;
        }
        return { ...memory };
      },
      async set(value) {
        Object.assign(memory, value);
      },
      async remove(key) {
        for (const name of [].concat(key)) delete memory[name];
      },
    },
  },
};

const { startReverseBridge, stopReverseBridge } = await import(
  "../extension/lib/reverse-bridge.js"
);

test("a stalled capability refresh does not hold a job that already arrived", async () => {
  for (const key of Object.keys(memory)) delete memory[key];
  memory.settings = {
    executorUrl: "http://exec:4400",
    executorApiKey: "exp_test",
    cdpMode: "off",
    accessMode: "limited",
  };

  let patchAborted = false;
  let resultPosted = false;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    if (method === "POST" && String(url).endsWith("/session")) {
      return new Response(JSON.stringify({ sessionId: "bbs_1", connection: "desktop" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (String(url).includes("/jobs")) {
      memory.settings = { ...memory.settings, cdpMode: "always" };
      return new Response(
        JSON.stringify({ jobs: [{ id: "job_1", tool: "ping", args: {} }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (method === "PATCH") {
      return new Promise((_resolve, reject) => {
        const abort = () => {
          patchAborted = true;
          reject(new Error("aborted"));
        };
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (method === "POST" && String(url).endsWith("/result")) {
      resultPosted = true;
      return new Response("{}", { status: 200 });
    }
    return new Response("missing", { status: 404 });
  };

  try {
    await startReverseBridge(async () => memory.settings);
    const deadline = Date.now() + 500;
    while (!resultPosted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(resultPosted, true);
    assert.equal(patchAborted, false);
    await stopReverseBridge();
    const abortDeadline = Date.now() + 300;
    while (!patchAborted && Date.now() < abortDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(patchAborted, true);
  } finally {
    globalThis.fetch = previousFetch;
    await stopReverseBridge();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  candidatesFromTabs,
  detectExecutor,
  expandUserInput,
  isPrivateHost,
  localCandidates,
  probeExecutor,
} from "../extension/lib/discovery.js";

const BRIDGE_401 = JSON.stringify({
  error:
    "browser bridge requires an API key (Authorization: Bearer … or x-api-key); a browser session cookie is not accepted",
});

/** A fetch stand-in driven by a path → response map, per origin. */
function server(routes) {
  return async (url) => {
    const { origin, pathname } = new URL(url);
    const handler = routes[origin];
    if (!handler) throw new Error("ECONNREFUSED");
    const hit = handler[pathname];
    if (!hit) return new Response("Cannot GET " + pathname, { status: 404 });
    return hit();
  };
}

const now = () => 0;

test("Executor with the browser bridge is identified", async () => {
  const fetch = server({
    "http://exec:3000": {
      "/api/browser-bridge/sessions": () => new Response(BRIDGE_401, { status: 401 }),
    },
  });

  const probe = await probeExecutor("http://exec:3000", { fetch, now });

  assert.equal(probe.ok, true);
  assert.equal(probe.verdict, "executor");
});

/**
 * The bug this file exists for.
 *
 * Any other app on the default port used to satisfy the probe, so the panel
 * showed a green "Reachable" and the connect step then failed at MCP with no
 * explanation. An answer is not an identification.
 */
test("an unrelated server on the same port is not Executor", async () => {
  const fetch = server({
    "http://localhost:3000": {
      "/": () => new Response("my other app", { status: 200 }),
      "/api/health": () => new Response("OK", { status: 200 }),
    },
  });

  const probe = await probeExecutor("http://localhost:3000", { fetch, now });

  assert.equal(probe.ok, false);
  assert.equal(probe.verdict, "not-executor");
  assert.match(probe.error, /Something else/);
});

test("an app that merely reports healthy JSON is still not Executor", async () => {
  const fetch = server({
    "http://localhost:3000": {
      "/api/health": () => new Response(JSON.stringify({ status: "up" }), { status: 200 }),
    },
  });

  assert.equal((await probeExecutor("http://localhost:3000", { fetch, now })).verdict, "not-executor");
});

test("a 401 from something that is not the bridge does not pass", async () => {
  const fetch = server({
    "http://proxy:3000": {
      "/api/browser-bridge/sessions": () =>
        new Response("Authentication required", { status: 401 }),
    },
  });

  assert.equal((await probeExecutor("http://proxy:3000", { fetch, now })).verdict, "not-executor");
});

test("Executor without the browser plugin says so, rather than 'unreachable'", async () => {
  const fetch = server({
    "http://exec:3000": {
      "/api/health": () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    },
  });

  const probe = await probeExecutor("http://exec:3000", { fetch, now });

  assert.equal(probe.ok, false);
  assert.equal(probe.verdict, "bridge-missing");
  assert.match(probe.error, /browser control is not enabled/);
});

test("Executor v2 health at /health is still Executor without browser control", async () => {
  const fetch = server({
    "http://exec:4400": {
      "/health": () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    },
  });

  const probe = await probeExecutor("http://exec:4400", { fetch, now });
  assert.equal(probe.verdict, "bridge-missing");
});

test("a degraded Executor is still recognised as Executor", async () => {
  const fetch = server({
    "http://exec:3000": {
      "/api/health": () => new Response(JSON.stringify({ status: "degraded" }), { status: 200 }),
    },
  });

  assert.equal((await probeExecutor("http://exec:3000", { fetch, now })).verdict, "bridge-missing");
});

test("nothing listening reads as unreachable, not as a wrong app", async () => {
  const probe = await probeExecutor("http://nobody:3000", { fetch: server({}), now });

  assert.equal(probe.verdict, "unreachable");
});

test("an empty address is rejected without a request", async () => {
  let calls = 0;
  const probe = await probeExecutor("  ", {
    fetch: async () => {
      calls += 1;
      return new Response("", { status: 200 });
    },
    now,
  });

  assert.equal(probe.verdict, "no-url");
  assert.equal(calls, 0);
});

test("autodetect skips the impostor and keeps looking", async () => {
  const fetch = server({
    "http://localhost:3000": { "/": () => new Response("someone else", { status: 200 }) },
    "http://127.0.0.1:3000": {
      "/api/browser-bridge/sessions": () => new Response(BRIDGE_401, { status: 401 }),
    },
  });

  const found = await detectExecutor(["http://localhost:3000", "http://127.0.0.1:3000"], {
    fetch,
    now,
  });

  assert.equal(found.ok, true);
  assert.equal(found.url, "http://127.0.0.1:3000");
});

test("a failed autodetect reports the nearest miss, not a flat 'not found'", async () => {
  const fetch = server({
    "http://localhost:3000": { "/": () => new Response("someone else", { status: 200 }) },
  });

  const found = await detectExecutor(["http://localhost:3000", "http://127.0.0.1:3000"], {
    fetch,
    now,
  });

  assert.equal(found.ok, false);
  assert.equal(found.verdict, "not-executor");
  assert.equal(found.url, "http://localhost:3000");
});

test("candidates are probed once even when the caller repeats them", async () => {
  const seen = [];
  const fetch = async (url) => {
    seen.push(url);
    throw new Error("ECONNREFUSED");
  };

  await detectExecutor(["http://a:3000", "http://a:3000", " http://a:3000 "], { fetch, now });

  // Three spellings of one address, probed as one. Sources overlap by design 
  // a remembered address is usually also the saved one and often an open tab.
  assert.deepEqual(new Set(seen.map((url) => new URL(url).origin)), new Set(["http://a:3000"]));
});

// ── finding it in the first place ────────────────────────────────────────────

test("a bare hostname is expanded, because a tailnet name resolves that way", async () => {
  const expanded = expandUserInput("workshop");

  // HTTPS first: a tailnet host is served over TLS far more often than not.
  assert.equal(expanded[0], "https://workshop");
  assert.ok(expanded.includes("http://workshop"));
  assert.ok(expanded.some((url) => url.startsWith("https://workshop:")));
});

test("a host:port keeps its port and is tried both ways", async () => {
  assert.deepEqual(expandUserInput("workshop:8444"), [
    "https://workshop:8444",
    "http://workshop:8444",
  ]);
});

test("a complete URL is taken as given", async () => {
  assert.deepEqual(expandUserInput("https://box.example:9000/"), ["https://box.example:9000"]);
  assert.deepEqual(expandUserInput("   "), []);
});

test("private space is recognised, including the range Tailscale uses", async () => {
  for (const host of [
    "localhost",
    "127.0.0.1",
    "10.1.2.3",
    "192.168.1.9",
    "172.20.0.4",
    "100.64.91.80", // CGNAT, a tailnet address
    "100.127.255.1",
    "box.ts.net",
    "printer.local",
  ]) {
    assert.equal(isPrivateHost(host), true, host);
  }
});

test("public hosts are never probed on the user's behalf", async () => {
  // Detect reads open tabs. If this let a public host through, opening the
  // panel would fire requests at whatever the user happened to be browsing.
  for (const host of [
    "example.com",
    "mail.google.com",
    "8.8.8.8",
    "172.15.0.1", // just below the private block
    "172.32.0.1", // just above it
    "100.63.0.1", // just below CGNAT
    "100.128.0.1", // just above it
    "notts.net",
    "",
  ]) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test("open tabs contribute their origins, deduped, public ones dropped", async () => {
  const candidates = candidatesFromTabs([
    "https://box.ts.net:8444/default/plugins/browser-bridge",
    "https://box.ts.net:8444/default/integrations",
    "https://news.example.com/article",
    "chrome://extensions",
    "http://192.168.1.5:3000/",
    undefined,
    "not a url",
  ]);

  assert.deepEqual(candidates.sort(), ["http://192.168.1.5:3000", "https://box.ts.net:8444"]);
});

test("the caller's priority decides the winner, not whichever host is quickest", async () => {
  // Both are Executor. The remembered address is listed first and must win even
  // though the local one answers immediately, otherwise Detect would drag a
  // user off their real deployment onto a stray local instance.
  const fetch = async (url) => {
    if (!url.includes("/api/browser-bridge/")) return new Response("", { status: 404 });
    if (url.startsWith("https://box.ts.net")) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return new Response(BRIDGE_401, { status: 401 });
  };

  // Real clock on purpose: with `now` stubbed flat, every probe reports 0ms and
  // a resolver that picked the fastest would be indistinguishable from one that
  // respects priority.
  const found = await detectExecutor(["https://box.ts.net:8444", "http://localhost:3000"], {
    fetch,
  });

  assert.equal(found.url, "https://box.ts.net:8444");
  assert.ok(found.ms >= 20, `the winner really was the slower one (${found.ms}ms)`);
});

test("a sweep does not run every probe at once", async () => {
  let inFlight = 0;
  let peak = 0;
  const fetch = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    throw new Error("ECONNREFUSED");
  };

  await detectExecutor(localCandidates(), { fetch, now, limit: 4 });

  assert.ok(localCandidates().length > 4, "the sweep is worth bounding");
  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
});

test("the local sweep covers more than the one port everything else uses", async () => {
  const ports = new Set(localCandidates().map((url) => new URL(url).port));
  assert.ok(ports.size > 1);
  assert.ok(ports.has("3000"));
});

test("a probe that never answers is abandoned rather than hanging Detect", async () => {
  // Without this, one unreachable tailnet host stalls the whole sweep.
  const fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });

  const probe = await probeExecutor("http://silent:3000", { fetch, now, timeoutMs: 20 });

  assert.equal(probe.verdict, "unreachable");
});

test("a dead address costs one request, not two", async () => {
  // A sweep is mostly dead addresses. Following a network-level failure with a
  // health check doubles the wait for every one of them and can never help: a
  // throw means nothing is listening, where a route declining to answer would
  // have arrived as a status.
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    throw new Error("ECONNREFUSED");
  };

  const probe = await probeExecutor("http://nobody:3000", { fetch, now });

  assert.equal(probe.verdict, "unreachable");
  assert.equal(calls, 1);
});

test("the sweep stops once it has a hit, instead of draining every address", async () => {
  // The right answer is second; everything after is a slow dead end. Detect
  // must not sit through them.
  const probed = [];
  const fetch = async (url) => {
    const origin = new URL(url).origin;
    probed.push(origin);
    if (origin === "http://found:3000" && url.includes("browser-bridge")) {
      return new Response(BRIDGE_401, { status: 401 });
    }
    throw new Error("ECONNREFUSED");
  };

  const many = ["http://a:1", "http://found:3000", ...Array.from({ length: 40 }, (_, i) => `http://x${i}:1`)];
  const found = await detectExecutor(many, { fetch, now, limit: 4 });

  assert.equal(found.ok, true);
  assert.equal(found.url, "http://found:3000");
  assert.ok(new Set(probed).size <= 4, `probed ${new Set(probed).size} addresses`);
});

test("a live impostor is a better explanation than a silent address", async () => {
  const fetch = server({
    "http://busy:3000": { "/": () => new Response("someone else", { status: 200 }) },
  });

  const found = await detectExecutor(["http://silent:1", "http://busy:3000"], { fetch, now });

  assert.equal(found.verdict, "not-executor");
  assert.equal(found.url, "http://busy:3000");
});

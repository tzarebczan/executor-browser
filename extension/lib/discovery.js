/**
 * Finding Executor, and deciding whether an address really is Executor.
 *
 * Two failures shaped this file.
 *
 * The first was accepting any answer. The original probe took any 2xx/401/403
 * from `/` as proof, so an unrelated dev server on the default port satisfied
 * it, and autodetect then saved that address. An answer is not an
 * identification. The browser-bridge route is the discriminator: unauthenticated
 * it replies 401 with a JSON body naming the bridge, which settles both "this is
 * Executor" and "the plugin this extension needs is mounted". Health alone would
 * not: `{"status":"ok"}` at /api/health is the most common shape in software.
 *
 * The second was looking in too few places. Detect only ever tried two
 * hard-coded localhost URLs, so it could not find a tailnet deployment at all 
 * a MagicDNS name is per-tailnet and unguessable. It now draws candidates from
 * places the address is actually known: addresses that worked before, the tabs
 * the user already has open, and a wider sweep of local ports.
 */

/** Only Executor with the browser bridge answers 401 here. */
export const BRIDGE_PROBE_PATH = "/api/browser-bridge/sessions";

/**
 * Ports worth trying on this machine.
 *
 * Not just 3000: that port belongs to whatever the user last started, and a
 * self-hosted Executor is as often behind a container mapping or a TLS port.
 */
export const LOCAL_PORTS = [3000, 3001, 4788, 5173, 8080, 8443, 8444];

const LOCAL_HOSTS = ["localhost", "127.0.0.1"];

/** A sweep is many requests; each one gets a short leash. */
const PROBE_TIMEOUT_MS = 2500;

/** How many probes are in flight at once during a sweep. */
const POOL = 6;

/**
 * @typedef {"executor" | "bridge-missing" | "not-executor" | "unreachable" | "no-url"} ProbeVerdict
 * @typedef {{ok: boolean, verdict: ProbeVerdict, error?: string, ms?: number,
 *   status?: number, url?: string}} ProbeResult
 */

async function fetchWithTimeout(doFetch, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, { method: "GET", cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} baseUrl
 * @param {{fetch?: typeof fetch, now?: () => number, timeoutMs?: number}} [deps]
 * @returns {Promise<ProbeResult>}
 */
export async function probeExecutor(baseUrl, deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch;
  const now = deps.now || (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const base = (baseUrl || "").trim().replace(/\/$/, "");
  if (!base) return { ok: false, verdict: "no-url", error: "No Executor URL" };

  const started = now();
  const elapsed = () => Math.max(0, Math.round(now() - started));
  let reached = false;

  try {
    const response = await fetchWithTimeout(doFetch, base + BRIDGE_PROBE_PATH, timeoutMs);
    reached = true;
    if (response.status === 401 || response.status === 403) {
      const body = await response.text().catch(() => "");
      if (/browser.?bridge/i.test(body)) {
        return {
          ok: true,
          verdict: "executor",
          status: response.status,
          ms: elapsed(),
          url: base,
        };
      }
    }
  } catch {
    // A throw here is network-level, DNS, refused, TLS, timeout, not a route
    // declining to answer, which would arrive as a status. Nothing is listening,
    // so the second request would only repeat the wait. During a sweep most
    // candidates land here, and skipping it halves the whole thing.
    return {
      ok: false,
      verdict: "unreachable",
      error: "Unreachable, check the URL, or join the tailnet",
      ms: elapsed(),
      url: base,
    };
  }

  // Executor without the plugin this extension needs. Worth naming precisely:
  // "unreachable" would send someone to check their network when the fix is on
  // the server. v1 answers /api/health; v2 answers /health. Either shape counts.
  for (const path of ["/api/health", "/health"]) {
    try {
      const response = await fetchWithTimeout(doFetch, base + path, timeoutMs);
      reached = true;
      const body = response.ok ? await response.text().catch(() => "") : "";
      if (/"status"\s*:\s*"(ok|degraded)"/.test(body)) {
        return {
          ok: false,
          verdict: "bridge-missing",
          error: "Executor is here, but browser control is not enabled on it",
          status: response.status,
          ms: elapsed(),
          url: base,
        };
      }
    } catch {
      // This path is not there. The other health path, or the verdict below,
      // still has to run.
    }
  }

  return reached
    ? {
        ok: false,
        verdict: "not-executor",
        error: "Something else is answering on this address",
        ms: elapsed(),
        url: base,
      }
    : {
        ok: false,
        verdict: "unreachable",
        error: "Unreachable, check the URL, or join the tailnet",
        ms: elapsed(),
        url: base,
      };
}

/** Every localhost origin worth a look. */
export function localCandidates() {
  return LOCAL_HOSTS.flatMap((host) => LOCAL_PORTS.map((port) => `http://${host}:${port}`));
}

/**
 * Turn what someone typed into addresses worth probing.
 *
 * People paste `workshop`, `workshop:8444`, or a MagicDNS name with no
 * scheme, and the old field rejected all three by simply probing the literal
 * string. On a tailnet the bare hostname resolves through the search domain, so
 * expanding it is usually all that is needed.
 */
export function expandUserInput(raw) {
  const value = (raw || "").trim().replace(/\/+$/, "");
  if (!value) return [];
  if (/^https?:\/\//i.test(value)) return [value];

  const hasPort = /:\d+$/.test(value);
  // A tailnet name is served over HTTPS far more often than not, so it leads.
  if (hasPort) return [`https://${value}`, `http://${value}`];

  const secure = [`https://${value}`];
  const withPorts = LOCAL_PORTS.flatMap((port) => [`https://${value}:${port}`]);
  return [...secure, `http://${value}`, ...withPorts];
}

/**
 * Hosts we are willing to probe unprompted.
 *
 * Detect reads the user's open tabs, which is the one place a tailnet address
 * reliably appears, but it must not turn into a scanner that sends requests to
 * every site they have open. Only private space qualifies: loopback, RFC1918,
 * the CGNAT range Tailscale uses, `.ts.net`, and the usual internal suffixes.
 * A public deployment is not discovered this way, which is the correct
 * trade, that address is one the user can paste, and it is remembered after.
 */
export function isPrivateHost(hostname) {
  const host = (hostname || "").toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "[::1]") return true;
  if (/\.(ts\.net|local|internal|lan|home\.arpa)$/.test(host)) return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 100.64.0.0/10, carrier-grade NAT, which is where Tailscale lives.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * Candidate origins from the tabs the user already has open.
 *
 * The console is where an API key is created, so anyone setting this up has had
 * Executor open in this browser, which makes their own tab list a better
 * source for an unguessable tailnet address than any list we could ship.
 */
export function candidatesFromTabs(urls = []) {
  const origins = new Set();
  for (const url of urls) {
    if (!url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      if (!isPrivateHost(parsed.hostname)) continue;
      origins.add(parsed.origin);
    } catch {
      // Not a URL we can use.
    }
  }
  return [...origins];
}

/**
 * First candidate that is Executor, not first that answers.
 *
 * Candidates arrive in priority order (remembered addresses, then open tabs,
 * then a local sweep) and are probed in concurrent batches of that order. A hit
 * anywhere in a batch means every higher-priority address has already been tried
 * and failed, so the search can stop there, which matters, because a full sweep
 * is dozens of addresses and nobody wants to watch all of them time out after
 * the right one has already answered.
 *
 * Batching also keeps priority meaningful: without it the quickest host would
 * win, and a stray local instance would drag the user off their real deployment.
 *
 * When nothing qualifies, the nearest miss is reported. "Something else is on
 * this address" ends the search; "not found" starts another one.
 *
 * @param {readonly string[]} candidates
 * @param {{fetch?: typeof fetch, now?: () => number, timeoutMs?: number, limit?: number}} [deps]
 */
export async function detectExecutor(candidates = [], deps = {}) {
  const list = [...new Set(candidates.filter(Boolean).map((url) => url.trim().replace(/\/$/, "")))];
  if (list.length === 0) {
    return { ok: false, verdict: "unreachable", error: "No addresses to try" };
  }

  const limit = Math.max(1, deps.limit ?? POOL);
  let nearest = null;

  for (let start = 0; start < list.length; start += limit) {
    const batch = list.slice(start, start + limit);
    const probes = await Promise.all(batch.map((url) => probeExecutor(url, deps)));

    const found = probes.find((probe) => probe.ok);
    if (found) return { ok: true, url: found.url, ms: found.ms, status: found.status };

    for (const probe of probes) {
      // A live server that is not Executor beats a silent address as an
      // explanation, and a bridge-less Executor beats both.
      if (probe.verdict === "bridge-missing") {
        nearest = probe;
        break;
      }
      if (probe.verdict === "not-executor" && nearest?.verdict !== "bridge-missing") {
        nearest ??= probe;
      }
    }
  }

  return nearest
    ? { ok: false, verdict: nearest.verdict, url: nearest.url, error: nearest.error }
    : {
        ok: false,
        verdict: "unreachable",
        error: `No Executor found at any of ${list.length} addresses`,
      };
}

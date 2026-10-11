/**
 * Which browser this extension is running in, and the name Executor should
 * give its catalog connection.
 *
 * Two unpacked installs (Chrome + Brave, or two Chrome profiles) must not
 * share one tools.browser.user.desktop slot. The instance id is stable across
 * reconnects; the connection name is what agents call.
 */

export const INSTANCE_KEY = "instanceId";

export function detectBrowser(
  userAgent = globalThis.navigator?.userAgent || "",
  brave = Boolean(globalThis.navigator?.brave),
) {
  if (brave) return "Brave";
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/OPR\/|Opera/i.test(userAgent)) return "Opera";
  if (/Vivaldi/i.test(userAgent)) return "Vivaldi";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/Chrome\//.test(userAgent)) return "Chrome";
  return "Chromium";
}

function slugConnectionName(raw, fallback = "desktop") {
  const words = String(raw || "")
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  if (!words || words.length === 0) return fallback;
  const slug = words
    .map((word, index) => (index === 0 ? word : `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`))
    .join("");
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(slug) ? slug : fallback;
}

/**
 * Name this instance will ask Executor for.
 *
 * An already-assigned name from a previous connect is reused so reconnects
 * keep the same tool address. Chrome without a label stays `desktop` so
 * existing agents keep working. Anything else is named after the product or
 * the user label.
 */
export function preferredConnectionName(browser, label, assigned) {
  if (assigned && /^[A-Za-z_][A-Za-z0-9_]*$/.test(assigned)) return assigned;
  const trimmed = String(label || "").trim();
  if (trimmed) return slugConnectionName(trimmed);
  const product = String(browser || "Chrome");
  const lower = product.toLowerCase();
  if (lower === "chrome" || lower === "chromium") return "desktop";
  return slugConnectionName(product);
}

export function localToolAddress(connectionName) {
  return `tools.browser.user.${connectionName || "desktop"}`;
}

export async function getInstanceId() {
  const stored = await chrome.storage.local.get(INSTANCE_KEY);
  if (typeof stored[INSTANCE_KEY] === "string" && stored[INSTANCE_KEY].length > 0) {
    return stored[INSTANCE_KEY];
  }
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTANCE_KEY]: id });
  return id;
}

export async function reverseClientIdentity(settings = {}) {
  const browser = detectBrowser();
  const instanceId = await getInstanceId();
  const label = String(settings.connectionLabel || "").trim();
  const connectionName = preferredConnectionName(
    browser,
    label,
    settings.connectionName,
  );
  return {
    browser,
    instanceId,
    label: label || browser,
    connectionName,
    client: {
      name: "executor-browser",
      version: chrome.runtime.getManifest().version,
      instanceId,
      browser,
      ...(label ? { label } : {}),
    },
    connection: { integration: "browser", name: connectionName, owner: "user" },
  };
}

/**
 * Extension browser tools (reverse bridge).
 * Uses chrome.tabs / scripting / captureVisibleTab — Executor group only.
 */

const GROUP_TITLE_DEFAULT = "Executor";
const GROUP_STORAGE_KEY = "executorAgentGroupId";
const GROUP_MIGRATION_KEY = "executorAgentGroupMigrated";
/** tabId → { url, nodes } — invalidated on navigate / URL change / size cap */
const snapshotHandles = new Map();
const SNAPSHOT_HANDLE_MAX = 24;

function clearSnapshotHandle(tabId) {
  if (tabId != null) snapshotHandles.delete(Number(tabId));
}

function rememberSnapshot(tabId, snapshot) {
  if (tabId == null || !snapshot) return;
  snapshotHandles.set(Number(tabId), {
    url: snapshot.url,
    nodes: snapshot.nodes,
  });
  while (snapshotHandles.size > SNAPSHOT_HANDLE_MAX) {
    const oldest = snapshotHandles.keys().next().value;
    snapshotHandles.delete(oldest);
  }
}

async function getGroupTitle() {
  try {
    const { settings } = await chrome.storage.local.get("settings");
    return settings?.groupTitle || GROUP_TITLE_DEFAULT;
  } catch {
    return GROUP_TITLE_DEFAULT;
  }
}

export async function listAgentTabs() {
  const groupId = await getOwnedGroupId();
  if (groupId == null) return [];
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => t.groupId === groupId)
    .map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      active: t.active,
      windowId: t.windowId,
    }));
}

async function getOwnedGroupId() {
  const stored = await chrome.storage.local.get([GROUP_STORAGE_KEY, GROUP_MIGRATION_KEY]);
  const groupId = stored?.[GROUP_STORAGE_KEY];
  if (Number.isInteger(groupId)) {
    try {
      await chrome.tabGroups.get(groupId);
      return groupId;
    } catch {
      await chrome.storage.local.remove(GROUP_STORAGE_KEY);
      await chrome.storage.local.set({ [GROUP_MIGRATION_KEY]: true });
      return null;
    }
  }

  if (stored?.[GROUP_MIGRATION_KEY]) return null;

  // One-time upgrade from v0.6, which identified the agent group by title only.
  const title = await getGroupTitle();
  const legacyGroups = await chrome.tabGroups.query({ title });
  await chrome.storage.local.set({ [GROUP_MIGRATION_KEY]: true });
  if (legacyGroups.length !== 1) return null;

  const legacyGroupId = legacyGroups[0].id;
  await chrome.storage.local.set({ [GROUP_STORAGE_KEY]: legacyGroupId });
  return legacyGroupId;
}

export async function ensureAgentTabGroup(tabIds) {
  const title = await getGroupTitle();
  let groupId = await getOwnedGroupId();
  if (groupId == null && tabIds?.length) {
    groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, { title, color: "blue", collapsed: false });
    await chrome.storage.local.set({
      [GROUP_STORAGE_KEY]: groupId,
      [GROUP_MIGRATION_KEY]: true,
    });
  } else if (groupId != null && tabIds?.length) {
    await chrome.tabs.group({ tabIds, groupId });
  }
  return groupId ?? null;
}

async function resolveTab(tabId) {
  const groupId = await getOwnedGroupId();
  if (groupId == null) return null;
  if (tabId != null) {
    try {
      const tab = await chrome.tabs.get(Number(tabId));
      return tab.groupId === groupId ? tab : null;
    } catch {
      return null;
    }
  }
  const agent = await listAgentTabs();
  const preferred = agent.find((t) => t.active) || agent[0];
  if (preferred) return chrome.tabs.get(preferred.id);
  return null;
}

function isRestrictedUrl(url = "") {
  return /^(chrome|chrome-extension|devtools|edge|about):/i.test(url);
}

/** Simplified a11y-ish snapshot via DOM walk in page. */
async function takeSnapshot(tabId) {
  const tab = await resolveTab(tabId);
  if (!tab?.id) return { ok: false, error: "No tab" };
  if (isRestrictedUrl(tab.url)) {
    return { ok: false, error: "Can't snapshot browser chrome pages", tab: { id: tab.id, url: tab.url } };
  }
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const max = 200;
      const nodes = [];
      const selectorFor = (el) => {
        if (el === document.body) return "body";
        if (el.id) return `#${CSS.escape(el.id)}`;
        const path = [];
        let current = el;
        while (current && current !== document.body) {
          const tag = current.tagName.toLowerCase();
          const siblings = current.parentElement
            ? [...current.parentElement.children].filter(
                (candidate) => candidate.tagName === current.tagName,
              )
            : [];
          const suffix =
            siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
          path.unshift(`${tag}${suffix}`);
          current = current.parentElement;
        }
        return `body > ${path.join(" > ")}`;
      };
      const walk = (el, depth) => {
        if (nodes.length >= max || depth > 8) return;
        if (!(el instanceof Element)) return;
        const tag = el.tagName.toLowerCase();
        if (["script", "style", "noscript", "svg", "path"].includes(tag)) return;
        const role = el.getAttribute("role") || "";
        const name =
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          (el.innerText || "").trim().slice(0, 80) ||
          el.getAttribute("name") ||
          el.getAttribute("href") ||
          "";
        const interactive =
          ["a", "button", "input", "textarea", "select", "option"].includes(tag) ||
          role === "button" ||
          el.onclick != null ||
          el.tabIndex >= 0;
        if (interactive || (name && name.length > 1)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            nodes.push({
              i: nodes.length,
              tag,
              role: role || undefined,
              name: name.slice(0, 100) || undefined,
              href: tag === "a" ? el.getAttribute("href") || undefined : undefined,
              type: tag === "input" ? el.getAttribute("type") || undefined : undefined,
              selector: selectorFor(el),
              x: Math.round(r.x + r.width / 2),
              y: Math.round(r.y + r.height / 2),
            });
          }
        }
        for (const c of el.children) walk(c, depth + 1);
      };
      walk(document.body, 0);
      return {
        url: location.href,
        title: document.title,
        nodes,
      };
    },
  });
  if (result?.url && Array.isArray(result.nodes)) {
    rememberSnapshot(tab.id, result);
  }
  return { ok: true, tab: { id: tab.id, url: tab.url, title: tab.title }, snapshot: result };
}

async function clickAt(tabId, { x, y, selector, nodeIndex } = {}) {
  const tab = await resolveTab(tabId);
  if (!tab?.id) return { ok: false, error: "No Executor-group tab" };
  if (isRestrictedUrl(tab.url)) return { ok: false, error: "Restricted URL" };

  if (!selector && x == null && y == null && nodeIndex != null) {
    const cached = snapshotHandles.get(tab.id);
    // Require URL match so navigations can't reuse stale node coordinates
    const handle =
      cached && cached.url === tab.url ? cached.nodes?.[nodeIndex] : null;
    if (!handle) {
      clearSnapshotHandle(tab.id);
      return { ok: false, error: "Snapshot handle expired; take a new snapshot" };
    }
    selector = handle.selector;
    x = handle.x;
    y = handle.y;
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [{ x, y, selector }],
    func: (opts) => {
      let el = null;
      if (opts.selector) el = document.querySelector(opts.selector);
      if (!el && opts.x != null && opts.y != null) {
        el = document.elementFromPoint(opts.x, opts.y);
      }
      if (!el) return { ok: false, error: "Element not found" };
      el.scrollIntoView({ block: "center", inline: "center" });
      el.focus?.();
      el.click();
      return {
        ok: true,
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || "").trim().slice(0, 80),
      };
    },
  });
  return { ...result, tabId: tab.id };
}

async function typeText(tabId, { text, selector, submit } = {}) {
  const tab = await resolveTab(tabId);
  if (!tab?.id) return { ok: false, error: "No Executor-group tab" };
  if (isRestrictedUrl(tab.url)) return { ok: false, error: "Restricted URL" };
  if (text == null) return { ok: false, error: "text required" };

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [{ text: String(text), selector, submit: Boolean(submit) }],
    func: (opts) => {
      let el = opts.selector
        ? document.querySelector(opts.selector)
        : document.activeElement;
      if (!el || (el !== document.body && !("value" in el) && el.isContentEditable !== true)) {
        el =
          document.querySelector("input:focus, textarea:focus, [contenteditable=true]:focus") ||
          document.querySelector("input:not([type=hidden]), textarea, [contenteditable=true]");
      }
      if (!el) return { ok: false, error: "No input focused — click a field first" };
      el.focus();
      if ("value" in el) {
        el.value = opts.text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = opts.text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (opts.submit) {
        const form = el.closest("form");
        if (form) {
          if (typeof form.requestSubmit === "function") form.requestSubmit();
          else form.submit();
        } else {
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        }
      }
      return { ok: true, tag: el.tagName.toLowerCase() };
    },
  });
  return { ...result, tabId: tab.id };
}

async function navigate(tabId, { url, newTab, active = true } = {}) {
  if (!url) return { ok: false, error: "url required" };
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { ok: false, error: "Only http(s) URLs are allowed" };
    }
  } catch {
    return { ok: false, error: "Only http(s) URLs are allowed" };
  }
  if (newTab) {
    const tab = await chrome.tabs.create({ url, active });
    await ensureAgentTabGroup([tab.id]);
    clearSnapshotHandle(tab.id);
    return { ok: true, tab: { id: tab.id, url: tab.url } };
  }
  const tab = await resolveTab(tabId);
  if (!tab?.id) {
    const created = await chrome.tabs.create({ url, active: true });
    await ensureAgentTabGroup([created.id]);
    clearSnapshotHandle(created.id);
    return { ok: true, tab: { id: created.id, url } };
  }
  clearSnapshotHandle(tab.id);
  await chrome.tabs.update(tab.id, { url });
  return { ok: true, tab: { id: tab.id, url } };
}

/** Chrome MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND — space agent screenshots too. */
let lastToolCaptureAt = 0;
const TOOL_CAPTURE_GAP_MS = 1100;

async function screenshot(tabId) {
  const tab = await resolveTab(tabId);
  if (!tab?.windowId) return { ok: false, error: "No tab window" };
  if (isRestrictedUrl(tab.url)) return { ok: false, error: "Restricted URL" };
  if (tab.id) await chrome.tabs.update(tab.id, { active: true });
  const wait = Math.max(0, TOOL_CAPTURE_GAP_MS - (Date.now() - lastToolCaptureAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  else await new Promise((r) => setTimeout(r, 100));
  lastToolCaptureAt = Date.now();
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 55,
    });
  } catch (e) {
    const msg = String(e?.message || e);
    if (/MAX_CAPTURE|quota|exceeds/i.test(msg)) {
      await new Promise((r) => setTimeout(r, TOOL_CAPTURE_GAP_MS));
      lastToolCaptureAt = Date.now();
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "jpeg",
        quality: 55,
      });
    } else {
      throw e;
    }
  }
  return {
    ok: true,
    tab: { id: tab.id, url: tab.url, title: tab.title },
    dataUrl,
    bytes: dataUrl.length,
    mime: "image/jpeg",
  };
}

/**
 * Dispatch a tool by name.
 * @param {string} tool
 * @param {object} args
 */
export async function runBrowserTool(tool, args = {}) {
  const name = String(tool || "").replace(/^tools\.chrome\.(user\.)?desktop\./, "");
  const tabId = args.tabId ?? args.tab_id ?? null;

  switch (name) {
    case "tabs.list":
    case "list_tabs":
    case "listTabs":
      return { ok: true, tabs: await listAgentTabs() };

    case "tabs.open":
    case "open_tab":
    case "openTab": {
      return navigate(null, { url: args.url, newTab: true, active: args.active !== false });
    }

    case "navigate":
    case "open":
      return navigate(tabId, args);

    case "snapshot":
    case "take_snapshot":
    case "takeSnapshot":
      return takeSnapshot(tabId);

    case "click":
      return clickAt(tabId, args);

    case "type":
    case "fill":
      return typeText(tabId, args);

    case "screenshot":
    case "capture": {
      return screenshot(tabId);
    }

    case "ping":
      return { ok: true, mode: "extension-reverse", ts: Date.now() };

    default:
      return {
        ok: false,
        error: `Unknown tool: ${name}`,
        supported: [
          "ping",
          "tabs.list",
          "tabs.open",
          "navigate",
          "snapshot",
          "click",
          "type",
          "screenshot",
        ],
      };
  }
}

export const BROWSER_TOOLS_META = {
  mode: "extension-reverse",
  tools: [
    "ping",
    "tabs.list",
    "tabs.open",
    "navigate",
    "snapshot",
    "click",
    "type",
    "screenshot",
  ],
};

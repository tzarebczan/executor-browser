/**
 * Extension-native browser tools (path B).
 * Uses chrome.tabs / scripting / captureVisibleTab — no companion port.
 */

const GROUP_TITLE_DEFAULT = "Executor";

async function getGroupTitle() {
  try {
    const { settings } = await chrome.storage.local.get("settings");
    return settings?.groupTitle || GROUP_TITLE_DEFAULT;
  } catch {
    return GROUP_TITLE_DEFAULT;
  }
}

async function listAgentTabs() {
  const title = await getGroupTitle();
  const groups = await chrome.tabGroups.query({ title });
  if (!groups.length) return [];
  const groupId = groups[0].id;
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

async function ensureGroup(tabIds) {
  const title = await getGroupTitle();
  const groups = await chrome.tabGroups.query({ title });
  let groupId = groups[0]?.id;
  if (groupId == null && tabIds?.length) {
    groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, { title, color: "blue", collapsed: false });
  } else if (groupId != null && tabIds?.length) {
    await chrome.tabs.group({ tabIds, groupId });
  }
  return groupId ?? null;
}

async function resolveTab(tabId) {
  if (tabId != null) {
    try {
      return await chrome.tabs.get(Number(tabId));
    } catch {
      /* fall through */
    }
  }
  const agent = await listAgentTabs();
  const preferred = agent.find((t) => t.active) || agent[0];
  if (preferred) return chrome.tabs.get(preferred.id);
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return active || null;
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
  return { ok: true, tab: { id: tab.id, url: tab.url, title: tab.title }, snapshot: result };
}

async function clickAt(tabId, { x, y, selector, nodeIndex } = {}) {
  const tab = await resolveTab(tabId);
  if (!tab?.id) return { ok: false, error: "No tab" };
  if (isRestrictedUrl(tab.url)) return { ok: false, error: "Restricted URL" };

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [{ x, y, selector, nodeIndex }],
    func: (opts) => {
      let el = null;
      if (opts.selector) el = document.querySelector(opts.selector);
      if (!el && opts.x != null && opts.y != null) {
        el = document.elementFromPoint(opts.x, opts.y);
      }
      if (!el && opts.nodeIndex != null) {
        // Rebuild same walk as snapshot — best-effort by index among interactive
        const list = [];
        const walk = (node, depth) => {
          if (list.length > 200 || depth > 8) return;
          if (!(node instanceof Element)) return;
          const tag = node.tagName.toLowerCase();
          if (["script", "style", "noscript", "svg", "path"].includes(tag)) return;
          const role = node.getAttribute("role") || "";
          const name =
            node.getAttribute("aria-label") ||
            node.getAttribute("placeholder") ||
            (node.innerText || "").trim().slice(0, 80) ||
            "";
          const interactive =
            ["a", "button", "input", "textarea", "select"].includes(tag) ||
            role === "button" ||
            node.tabIndex >= 0;
          if (interactive || (name && name.length > 1)) {
            const r = node.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) list.push(node);
          }
          for (const c of node.children) walk(c, depth + 1);
        };
        walk(document.body, 0);
        el = list[opts.nodeIndex] || null;
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
  if (!tab?.id) return { ok: false, error: "No tab" };
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
        if (form) form.requestSubmit?.() || form.submit();
        else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }
      return { ok: true, tag: el.tagName.toLowerCase() };
    },
  });
  return { ...result, tabId: tab.id };
}

async function navigate(tabId, { url, newTab } = {}) {
  if (!url) return { ok: false, error: "url required" };
  if (newTab) {
    const tab = await chrome.tabs.create({ url, active: true });
    await ensureGroup([tab.id]);
    return { ok: true, tab: { id: tab.id, url: tab.url } };
  }
  const tab = await resolveTab(tabId);
  if (!tab?.id) {
    const created = await chrome.tabs.create({ url, active: true });
    await ensureGroup([created.id]);
    return { ok: true, tab: { id: created.id, url } };
  }
  await chrome.tabs.update(tab.id, { url });
  return { ok: true, tab: { id: tab.id, url } };
}

async function screenshot(tabId) {
  const tab = await resolveTab(tabId);
  if (!tab?.windowId) return { ok: false, error: "No tab window" };
  if (isRestrictedUrl(tab.url)) return { ok: false, error: "Restricted URL" };
  if (tab.id) await chrome.tabs.update(tab.id, { active: true });
  await new Promise((r) => setTimeout(r, 100));
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "jpeg",
    quality: 55,
  });
  return {
    ok: true,
    tab: { id: tab.id, url: tab.url, title: tab.title },
    // Keep payload small in bridge results
    dataUrl: dataUrl.slice(0, 120) + "…",
    bytes: dataUrl.length,
    mime: "image/jpeg",
    // full only for local callers that need it
    _fullDataUrl: dataUrl,
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
      const tab = await chrome.tabs.create({
        url: args.url || "about:blank",
        active: args.active !== false,
      });
      await ensureGroup([tab.id]);
      return { ok: true, tab: { id: tab.id, url: tab.url } };
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
      const res = await screenshot(tabId);
      if (args.full) return { ...res, dataUrl: res._fullDataUrl };
      const { _fullDataUrl, ...rest } = res;
      return rest;
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

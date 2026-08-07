/**
 * Extension browser tools (reverse bridge).
 * Uses chrome.tabs / scripting / captureVisibleTab, Executor group only.
 */

import {
  ACCESS_CODES,
  BrowserAccessError,
  accessAdvertisement,
  assertToolAccess,
  endControlSession,
  getAccessState,
  hostAllowed,
} from "./access-policy.js";
import { runCdpTool } from "./cdp-tools.js";
import { redactUrl } from "./redact.js";

/**
 * Failure codes shared with Executor's `BROWSER_ERROR_CODES`.
 *
 * The access codes come from the policy module so a refusal keeps saying which
 * limit stopped it; everything else that fails is tagged here.
 */
export const TOOL_CODES = Object.freeze({
  ...ACCESS_CODES,
  noTab: "NO_TARGET_TAB",
  unsupported: "TOOL_NOT_SUPPORTED",
  failed: "TOOL_FAILED",
});

const GROUP_TITLE_DEFAULT = "Executor";
const GROUP_STORAGE_KEY = "executorAgentGroupId";
const GROUP_MIGRATION_KEY = "executorAgentGroupMigrated";
/** tabId → { url, nodes }, invalidated on navigate / URL change / size cap */
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

/**
 * Resolve the tab a tool should act on and authorize it.
 *
 * Returns null only when there is genuinely no candidate tab. A tab that
 * exists but is out of scope raises BrowserAccessError, so a refusal is never
 * reported as a missing target.
 */
async function resolveTab(tabId, tool) {
  const groupId = await getOwnedGroupId();
  let candidate = null;
  if (tabId != null) {
    try {
      candidate = await chrome.tabs.get(Number(tabId));
    } catch {
      return null;
    }
  } else {
    const agent = await listAgentTabs();
    const preferred = agent.find((t) => t.active) || agent[0];
    if (!preferred) return null;
    try {
      candidate = await chrome.tabs.get(preferred.id);
    } catch {
      return null;
    }
  }
  await assertToolAccess({ tool, tab: candidate, groupId });
  return candidate;
}

function isRestrictedUrl(url = "") {
  return /^(chrome|chrome-extension|devtools|edge|about):/i.test(url);
}

/** Simplified a11y-ish snapshot via DOM walk in page. */
async function takeSnapshot(tabId, options = {}) {
  const tab = await resolveTab(tabId);
  if (!tab?.id) return { ok: false, error: "No tab", code: TOOL_CODES.noTab };
  if (isRestrictedUrl(tab.url)) {
    return { ok: false, error: "Can't snapshot browser chrome pages", tab: { id: tab.id, url: tab.url } };
  }
  const frames = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    args: [{ max: Math.min(1000, Math.max(1, Number(options.maxNodes) || 200)), includeHidden: Boolean(options.includeHidden) }],
    func: (opts) => {
      const max = opts.max;
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
          if (opts.includeHidden || (r.width > 0 && r.height > 0)) {
            nodes.push({
              i: nodes.length,
              index: nodes.length,
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
  const top = frames.find((frame) => frame.frameId === 0)?.result || frames[0]?.result;
  const nodes = frames.flatMap((frame) =>
    (frame.result?.nodes || []).map((node) => ({
      ...node,
      i: 0,
      index: 0,
      frameId: frame.frameId,
    })),
  );
  nodes.forEach((node, index) => {
    node.i = index;
    node.index = index;
  });
  const result = { url: top?.url || tab.url, title: top?.title || tab.title, nodes };
  if (result.url && Array.isArray(result.nodes)) {
    rememberSnapshot(tab.id, result);
  }
  return { ok: true, tab: { id: tab.id, url: tab.url, title: tab.title }, snapshot: result };
}

async function clickAt(tabId, { x, y, selector, nodeIndex, frameId } = {}) {
  const tab = await resolveTab(tabId);
  if (!tab?.id) return { ok: false, error: "No Executor-group tab", code: TOOL_CODES.noTab };
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
    frameId = handle.frameId;
  }

  const settle = watchNavigation(tab.id);
  const [{ result }] = await chrome.scripting.executeScript({
    target: frameId == null ? { tabId: tab.id } : { tabId: tab.id, frameIds: [frameId] },
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
  const navigated = await settle();
  // Node coordinates belong to the page they were captured on, so a navigation
  // retires them rather than letting a later nodeIndex land somewhere else.
  if (navigated) clearSnapshotHandle(tab.id);
  return {
    ...result,
    tabId: tab.id,
    url: await settledUrl(tab.id, tab.url),
    ...(navigated ? { navigated: true } : {}),
  };
}

async function typeText(tabId, { text, selector, submit } = {}) {
  const tab = await resolveTab(tabId);
  if (!tab?.id) return { ok: false, error: "No Executor-group tab", code: TOOL_CODES.noTab };
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
      if (!el) return { ok: false, error: "No input focused, click a field first" };
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

/**
 * How long a navigation has to start before an action counts as one that did
 * not navigate, and how long to then wait for the page to finish loading.
 *
 * Split so an ordinary click does not pay for the answer. Only once Chrome has
 * reported the tab loading is the longer budget spent.
 */
const NAV_COMMIT_MS = 400;
const NAV_SETTLE_MS = 15000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run an action and wait for any navigation it starts.
 *
 * The listener is attached before the action, because a click that follows a
 * link can have the tab loading before `executeScript` resolves. Attaching
 * afterwards misses that entirely.
 *
 * Without this a click returned while the old page was still on screen, so the
 * next call read the URL the tab was leaving rather than the one it was going
 * to, and reported the click as having done nothing.
 */
function watchNavigation(tabId) {
  let started = false;
  let finished = false;
  const listener = (id, changeInfo) => {
    if (id !== tabId) return;
    if (changeInfo.url || changeInfo.status === "loading") started = true;
    if (changeInfo.status === "complete") finished = true;
  };
  chrome.tabs.onUpdated.addListener(listener);
  return async () => {
    try {
      const commitBy = Date.now() + NAV_COMMIT_MS;
      while (!started && Date.now() < commitBy) await delay(20);
      if (!started) return false;
      const settleBy = Date.now() + NAV_SETTLE_MS;
      while (!finished && Date.now() < settleBy) await delay(25);
      return true;
    } finally {
      chrome.tabs.onUpdated.removeListener(listener);
    }
  };
}

/** The tab's real URL now, rather than the one it was asked to go to. */
async function settledUrl(tabId, fallback) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url || fallback;
  } catch {
    return fallback;
  }
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
  const access = await getAccessState();
  if (
    access.settings.accessMode === "limited" &&
    !hostAllowed(url, access.settings.allowedHosts)
  ) {
    return {
      ok: false,
      error: `Host is outside the configured access scope: ${url}`,
      code: TOOL_CODES.hostNotAllowed,
    };
  }
  // A created tab has no URL yet: Chrome resolves `create` before the
  // navigation commits, so reading `tab.url` straight back returned an empty
  // string and the caller had nothing to verify against.
  if (newTab) {
    const tab = await chrome.tabs.create({ url, active });
    await ensureAgentTabGroup([tab.id]);
    clearSnapshotHandle(tab.id);
    await settleTab(tab.id);
    return { ok: true, tab: { id: tab.id, url: await settledUrl(tab.id, url) } };
  }
  const tab = await resolveTab(tabId);
  if (!tab?.id) {
    const created = await chrome.tabs.create({ url, active: true });
    await ensureAgentTabGroup([created.id]);
    clearSnapshotHandle(created.id);
    await settleTab(created.id);
    return { ok: true, tab: { id: created.id, url: await settledUrl(created.id, url) } };
  }
  clearSnapshotHandle(tab.id);
  // The requested URL was reported before the tab had gone anywhere, which
  // reads as a completed navigation to a caller about to snapshot.
  const settle = watchNavigation(tab.id);
  await chrome.tabs.update(tab.id, { url });
  const navigated = await settle();
  return {
    ok: true,
    tab: { id: tab.id, url: navigated ? await settledUrl(tab.id, url) : url },
  };
}

/** Wait for a tab that is already on its way to finish loading. */
async function settleTab(tabId) {
  let finished = false;
  const listener = (id, changeInfo) => {
    if (id === tabId && changeInfo.status === "complete") finished = true;
  };
  chrome.tabs.onUpdated.addListener(listener);
  try {
    const settleBy = Date.now() + NAV_SETTLE_MS;
    while (!finished && Date.now() < settleBy) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return;
      if (tab.status === "complete" && tab.url) return;
      await delay(25);
    }
  } finally {
    chrome.tabs.onUpdated.removeListener(listener);
  }
}

/** Chrome MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND, space agent screenshots too. */
let lastToolCaptureAt = 0;
const TOOL_CAPTURE_GAP_MS = 1100;

async function screenshot(tabId) {
  const tab = await resolveTab(tabId);
  if (!tab?.windowId) return { ok: false, error: "No tab window", code: TOOL_CODES.noTab };
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

async function listControllableTabs() {
  const [state, groupId, tabs] = await Promise.all([
    getAccessState(),
    getOwnedGroupId(),
    chrome.tabs.query({}),
  ]);
  return tabs
    .filter((tab) => {
      if (!/^https?:/i.test(String(tab.url || ""))) return false;
      if (
        state.settings.accessMode === "limited" &&
        !hostAllowed(tab.url, state.settings.allowedHosts)
      ) return false;
      return state.settings.accessMode === "full" && state.sessionActive
        ? true
        : tab.groupId === groupId;
    })
    .map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      active: tab.active,
      windowId: tab.windowId,
      groupId: tab.groupId,
      controlled: tab.groupId === groupId,
    }));
}

function targetFromSnapshot(tab, args) {
  if (args.selector || args.nodeIndex == null) return args;
  const cached = snapshotHandles.get(tab.id);
  const handle = cached && cached.url === tab.url ? cached.nodes?.[args.nodeIndex] : null;
  if (!handle) throw new Error("Snapshot handle expired; take a new snapshot");
  return { ...args, selector: handle.selector, x: handle.x, y: handle.y };
}

async function domAction(tabId, action, args = {}) {
  const tab = await resolveTab(tabId);
  if (!tab?.id) return { ok: false, error: "No controllable tab", code: TOOL_CODES.noTab };
  if (isRestrictedUrl(tab.url)) return { ok: false, error: "Restricted URL" };
  let target;
  try {
    target = targetFromSnapshot(tab, args);
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
  const scriptTarget = target.frameId == null ? { tabId: tab.id } : { tabId: tab.id, frameIds: [target.frameId] };
  // Enter submits a form and a double-click can follow a link, so these two
  // navigate as readily as a click does. The rest cannot, and are not made to
  // wait to establish it.
  const settle = action === "press" || action === "dblclick" ? watchNavigation(tab.id) : null;
  const [{ result }] = await chrome.scripting.executeScript({
    target: scriptTarget,
    args: [action, target],
    func: (kind, opts) => {
      let el = opts.selector ? document.querySelector(opts.selector) : null;
      if (!el && opts.x != null && opts.y != null) el = document.elementFromPoint(opts.x, opts.y);
      if (!el && !["press", "scroll"].includes(kind)) return { ok: false, error: "Element not found" };
      if (kind === "focus") el.focus();
      if (kind === "hover") {
        el.scrollIntoView({ block: "center", inline: "center" });
        for (const type of ["pointerover", "mouseover", "pointerenter", "mouseenter"]) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: opts.x || 0, clientY: opts.y || 0 }));
        }
      }
      if (kind === "dblclick") {
        el.scrollIntoView({ block: "center", inline: "center" });
        el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
      }
      if (kind === "press") {
        el = el || document.activeElement || document.body;
        const init = {
          key: opts.key,
          code: opts.key,
          bubbles: true,
          altKey: opts.modifiers?.includes("Alt"),
          ctrlKey: opts.modifiers?.includes("Control"),
          metaKey: opts.modifiers?.includes("Meta"),
          shiftKey: opts.modifiers?.includes("Shift"),
        };
        el.dispatchEvent(new KeyboardEvent("keydown", init));
        el.dispatchEvent(new KeyboardEvent("keyup", init));
        if (opts.key === "Enter") el.closest?.("form")?.requestSubmit?.();
      }
      if (kind === "select") {
        if (!(el instanceof HTMLSelectElement)) return { ok: false, error: "Target is not a select" };
        const values = new Set(opts.values || []);
        for (const option of el.options) option.selected = values.has(option.value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (kind === "check") {
        if (!(el instanceof HTMLInputElement) || !["checkbox", "radio"].includes(el.type)) {
          return { ok: false, error: "Target is not a checkbox or radio" };
        }
        if (el.checked !== Boolean(opts.checked)) el.click();
      }
      if (kind === "scroll") {
        const scroller = el || document.scrollingElement;
        if (opts.x != null || opts.y != null) scroller.scrollTo({ left: opts.x || 0, top: opts.y || 0, behavior: "instant" });
        else scroller.scrollBy({ left: opts.deltaX || 0, top: opts.deltaY || 0, behavior: "instant" });
      }
      if (kind === "upload") {
        if (!(el instanceof HTMLInputElement) || el.type !== "file") return { ok: false, error: "Target is not a file input" };
        const transfer = new DataTransfer();
        for (const item of opts.files || []) {
          const raw = atob(item.dataBase64);
          const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
          transfer.items.add(new File([bytes], item.name, { type: item.mimeType || "application/octet-stream" }));
        }
        el.files = transfer.files;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { ok: true, tag: el?.tagName?.toLowerCase() };
    },
  });
  const navigated = settle ? await settle() : false;
  if (navigated) clearSnapshotHandle(tab.id);
  return { ...result, tabId: tab.id, ...(settle ? { url: await settledUrl(tab.id, tab.url) } : {}), ...(navigated ? { navigated: true } : {}), ...(action === "select" ? { values: args.values } : {}), ...(action === "check" ? { checked: args.checked } : {}), ...(action === "upload" ? { files: args.files.map((file) => file.name) } : {}) };
}

async function historyAction(tabId, action, args = {}) {
  const tab = await resolveTab(tabId);
  if (!tab?.id) return { ok: false, error: "No controllable tab", code: TOOL_CODES.noTab };
  if (isRestrictedUrl(tab.url)) return { ok: false, error: "Restricted URL" };
  if (action === "back") await chrome.tabs.goBack(tab.id);
  else if (action === "forward") await chrome.tabs.goForward(tab.id);
  else await chrome.tabs.reload(tab.id, { bypassCache: Boolean(args.bypassCache) });
  clearSnapshotHandle(tab.id);
  return { ok: true, tab: { id: tab.id, url: tab.url, title: tab.title } };
}

async function findElements(tabId, args = {}) {
  const result = await takeSnapshot(tabId);
  if (!result.ok) return result;
  const text = String(args.text || "").toLowerCase();
  const role = String(args.role || "").toLowerCase();
  const matches = (result.snapshot?.nodes || []).filter((node) => {
    if (args.selector && node.selector !== args.selector) return false;
    if (role && String(node.role || node.tag || "").toLowerCase() !== role) return false;
    return !text || `${node.name || ""} ${node.text || ""}`.toLowerCase().includes(text);
  }).slice(0, Math.min(100, Number(args.limit) || 20));
  return { ok: true, tab: result.tab, matches };
}

async function waitFor(tabId, args = {}) {
  const startedAt = Date.now();
  const timeoutMs = Math.min(120_000, Math.max(100, Number(args.timeoutMs) || 10_000));
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await resolveTab(tabId);
    if (!tab?.id) return { ok: false, error: "No controllable tab", code: TOOL_CODES.noTab };
    const urlMatched = !args.url || String(tab.url || "").includes(args.url);
    const found = args.selector || args.text ? await findElements(tab.id, args) : { ok: true, matches: [{}] };
    const present = Boolean(found.ok && found.matches?.length);
    const expected = ["hidden", "gone"].includes(args.state) ? !present : present;
    if (urlMatched && expected) return { ok: true, matched: true, elapsedMs: Date.now() - startedAt };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { ok: false, error: `Wait timed out after ${timeoutMs}ms`, code: "TIMEOUT" };
}

async function runAdvanced(tool, tabId, args) {
  const tab = await resolveTab(tabId);
  if (!tab?.id) return { ok: false, error: "No controllable tab", code: TOOL_CODES.noTab };
  const groupId = await getOwnedGroupId();
  await assertToolAccess({ tool, tab, groupId, advanced: true });
  const result = await runCdpTool(tool, tab.id, args);
  return tool === "screenshot" && result.ok ? { ...result, tab: { id: tab.id, url: tab.url, title: tab.title } } : result;
}

/**
 * Dispatch a tool by name.
 * @param {string} tool
 * @param {object} args
 */
export async function runBrowserTool(tool, args = {}) {
  try {
    const result = await dispatchBrowserTool(tool, args);
    // Every failure leaves here with a code. An agent deciding whether to
    // retry, ask for wider access, or stop cannot get that from prose, and
    // prose is the thing most likely to be reworded later.
    return result && result.ok === false && !result.code
      ? { ...result, code: TOOL_CODES.failed }
      : result;
  } catch (error) {
    if (error instanceof BrowserAccessError) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: String(error?.message || error), code: TOOL_CODES.failed };
  }
}

async function dispatchBrowserTool(tool, args = {}) {
  const name = String(tool || "").replace(/^tools\.chrome\.(user\.)?desktop\./, "");
  const tabId = args.tabId ?? args.tab_id ?? null;

  // Answered before the access gate below, deliberately. Both are about the
  // session rather than about the page: reading its state and ending it stay
  // available exactly when access is paused, which is when someone is most
  // likely to be asking what happened.
  //
  // There is no counterpart that starts a session. That is granted here, by the
  // person, and a tool that did it would let an agent award itself the reach
  // this step exists to withhold.
  if (name === "session.status" || name === "session_status") {
    return { ok: true, ...(await accessAdvertisement()) };
  }
  if (name === "session.stop" || name === "session_stop") {
    await endControlSession();
    // Reported as stopped whether or not one was running: nothing running is
    // the state the caller asked for.
    return { ok: true, stopped: true };
  }

  const access = await getAccessState();
  if (access.settings.accessMode === "full" && !access.sessionActive && name !== "ping") {
    return {
      ok: false,
      error: "Full access is paused. Start a control session in Executor Browser.",
      code: ACCESS_CODES.sessionRequired,
    };
  }

  switch (name) {
    case "tabs.list":
    case "list_tabs":
    case "listTabs":
      return { ok: true, tabs: await listControllableTabs() };

    case "tabs.open":
    case "open_tab":
    case "openTab": {
      return navigate(null, { url: args.url, newTab: true, active: args.active !== false });
    }

    case "navigate":
    case "open":
      return navigate(tabId, args);

    case "tabs.activate": {
      const tab = await resolveTab(tabId);
      if (!tab?.id) return { ok: false, error: "No controllable tab", code: TOOL_CODES.noTab };
      const updated = await chrome.tabs.update(tab.id, { active: true });
      return { ok: true, tab: { id: updated.id, url: updated.url, title: updated.title } };
    }

    case "tabs.close": {
      const tab = await resolveTab(tabId);
      if (!tab?.id) return { ok: false, error: "No controllable tab", code: TOOL_CODES.noTab };
      await chrome.tabs.remove(tab.id);
      clearSnapshotHandle(tab.id);
      return { ok: true, tabId: tab.id };
    }

    case "back":
    case "forward":
    case "reload":
      return historyAction(tabId, name, args);

    case "snapshot":
    case "take_snapshot":
    case "takeSnapshot":
      return takeSnapshot(tabId, args);

    case "find":
      return findElements(tabId, args);

    case "wait":
      return waitFor(tabId, args);

    case "click":
      return clickAt(tabId, args);

    case "dblclick":
    case "hover":
    case "focus":
    case "press":
    case "select":
    case "check":
    case "scroll":
    case "upload":
      return domAction(tabId, name, args);

    case "type":
    case "fill":
      return typeText(tabId, args);

    case "screenshot":
    case "capture": {
      if (args.fullPage) return runAdvanced("screenshot", tabId, args);
      return screenshot(tabId);
    }

    case "downloads.list": {
      const items = await chrome.downloads.search({
        limit: Math.min(100, Number(args.limit) || 20),
        ...(args.state ? { state: args.state } : {}),
        orderBy: ["-startTime"],
      });
      return {
        ok: true,
        // Shaped to the protocol's BrowserDownloadEntry: a string id and epoch
        // ms, so a caller does not get a number here and a string from a remote
        // target. `url` is reduced to origin + path, like every other URL that
        // leaves the extension.
        downloads: items.map((item) => ({
          id: String(item.id),
          url: redactUrl(item.url || ""),
          filename: item.filename,
          state: item.state,
          danger: item.danger,
          startedAt: Date.parse(item.startTime) || 0,
          ...(item.endTime ? { completedAt: Date.parse(item.endTime) || 0 } : {}),
          bytes: item.bytesReceived,
          totalBytes: item.totalBytes,
        })),
      };
    }

    case "dialog.handle":
    case "console.list":
    case "network.list":
    case "evaluate":
    case "pdf":
    case "viewport.set":
      return runAdvanced(name, tabId, args);

    case "ping":
      return { ok: true, mode: "extension-reverse", ts: Date.now(), protocolVersion: 2 };

    default:
      return {
        ok: false,
        error: `Unknown tool: ${name}`,
        code: TOOL_CODES.unsupported,
        supported: BROWSER_TOOL_NAMES,
      };
  }
}

export const BROWSER_TOOL_NAMES = Object.freeze([
  "session.status", "session.stop",
  "ping", "tabs.list", "tabs.open", "tabs.activate", "tabs.close", "navigate", "back", "forward", "reload",
  "snapshot", "find", "wait", "click", "dblclick", "hover", "focus", "type", "press", "select", "check", "scroll",
  "screenshot", "upload", "downloads.list", "dialog.handle", "console.list", "network.list", "evaluate", "pdf", "viewport.set",
]);

export const BROWSER_TOOLS_META = {
  protocolVersion: 2,
  mode: "extension-reverse",
  tools: BROWSER_TOOL_NAMES,
};

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const state = {
  groupId: 11,
  storedGroupId: 11,
  groupMigrated: true,
  tabs: new Map(),
  tabListeners: new Set(),
  pendingCreate: null,
  executeScript: null,
  captureDataUrl: "data:image/jpeg;base64,full-image-data",
  settings: { groupTitle: "Executor" },
};

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (key === "settings") return { settings: state.settings };
        if (Array.isArray(key)) {
          return {
            settings: state.settings,
            ...(state.storedGroupId != null
              ? { executorAgentGroupId: state.storedGroupId }
              : {}),
            ...(state.groupMigrated ? { executorAgentGroupMigrated: true } : {}),
          };
        }
        return {};
      },
      async set(value) {
        if (Number.isInteger(value.executorAgentGroupId)) {
          state.storedGroupId = value.executorAgentGroupId;
        }
        if (value.executorAgentGroupMigrated) state.groupMigrated = true;
      },
      async remove() {
        state.storedGroupId = null;
      },
    },
  },
  tabGroups: {
    async query({ title }) {
      return state.groupId != null && title === "Executor"
        ? [{ id: state.groupId, title: "Executor" }]
        : [];
    },
    async get(groupId) {
      if (groupId !== state.groupId) throw new Error("missing group");
      return { id: groupId, title: "Executor" };
    },
    async update() {},
  },
  tabs: {
    async query() {
      return [...state.tabs.values()];
    },
    async get(tabId) {
      const tab = state.tabs.get(tabId);
      if (!tab) throw new Error("missing tab");
      return tab;
    },
    async group() {
      return state.groupId ?? 11;
    },
    // Chrome resolves `create` before the navigation commits, so a new tab has
    // no URL yet and reports itself as still loading.
    async create({ active }) {
      const tab = { id: 20, groupId: -1, windowId: 1, url: "", status: "loading", active };
      state.tabs.set(tab.id, tab);
      state.pendingCreate?.(tab);
      return tab;
    },
    async update(tabId, patch) {
      const tab = state.tabs.get(tabId);
      Object.assign(tab, patch);
      return tab;
    },
    async captureVisibleTab() {
      return state.captureDataUrl;
    },
    onUpdated: {
      addListener(fn) {
        state.tabListeners.add(fn);
      },
      removeListener(fn) {
        state.tabListeners.delete(fn);
      },
    },
  },
  scripting: {
    async executeScript(options) {
      return state.executeScript(options);
    },
  },
};

const { runBrowserTool } = await import("../extension/lib/browser-tools.js");

beforeEach(() => {
  state.groupId = 11;
  state.storedGroupId = 11;
  state.groupMigrated = true;
  state.settings = { groupTitle: "Executor" };
  state.tabs = new Map([
    [1, { id: 1, groupId: 11, windowId: 1, url: "https://example.test", active: true }],
    [7, { id: 7, groupId: 99, windowId: 1, url: "https://private.test", active: false }],
  ]);
  state.tabListeners = new Set();
  state.pendingCreate = null;
  state.executeScript = () => {
    throw new Error("unexpected script execution");
  };
});

/** Chrome reporting a tab committing to a new URL and finishing its load. */
function completeNavigation(tabId, url) {
  const tab = state.tabs.get(tabId);
  if (tab) Object.assign(tab, { url, status: "complete" });
  for (const listener of [...state.tabListeners]) listener(tabId, { status: "loading", url });
  for (const listener of [...state.tabListeners]) listener(tabId, { status: "complete" });
}

test("opening a tab reports where it landed, not an empty URL", async () => {
  // chrome.tabs.create resolves before the navigation commits, so returning
  // tab.url straight back handed the caller an empty string to verify against.
  state.pendingCreate = (tab) => {
    setTimeout(() => completeNavigation(tab.id, "https://example.test/landed"), 10);
  };

  const result = await runBrowserTool("tabs.open", { url: "https://example.test/landed" });

  assert.equal(result.ok, true);
  assert.equal(result.tab.url, "https://example.test/landed");
});

test("a click that navigates reports the new URL and retires the old snapshot", async () => {
  // The click used to return while the old page was still on screen, so the
  // next call read the URL the tab was leaving rather than the one it reached.
  state.executeScript = () => {
    setTimeout(() => completeNavigation(1, "https://example.test/next"), 10);
    return [{ result: { ok: true, tag: "a", text: "Learn more" } }];
  };

  const result = await runBrowserTool("click", { tabId: 1, selector: "a" });

  assert.equal(result.ok, true);
  assert.equal(result.navigated, true);
  assert.equal(result.url, "https://example.test/next");
});

test("a click that does not navigate returns promptly and says so", async () => {
  // Opening a menu must not pay the load budget to establish that nothing
  // navigated.
  state.executeScript = () => [{ result: { ok: true, tag: "button", text: "Menu" } }];

  const started = Date.now();
  const result = await runBrowserTool("click", { tabId: 1, selector: "button" });

  assert.equal(result.ok, true);
  assert.equal(result.navigated, undefined);
  assert.ok(Date.now() - started < 2000, "a non-navigating click should not wait for a load");
});

test("rejects an explicit tab outside the extension-owned group", async () => {
  const result = await runBrowserTool("snapshot", { tabId: 7 });
  assert.equal(result.ok, false);
});

test("does not fall back to a personal active tab when no owned group exists", async () => {
  state.storedGroupId = null;
  const result = await runBrowserTool("snapshot", {});
  assert.equal(result.ok, false);
});

test("enforces the site allowlist when no tabId is supplied", async () => {
  // The implicit-active-tab path is how agents normally call these tools, so it
  // must be authorized exactly like an explicit tabId.
  state.settings = { groupTitle: "Executor", accessMode: "limited", allowedHosts: ["example.com"] };
  state.tabs = new Map([
    [1, { id: 1, groupId: 11, windowId: 1, url: "https://out-of-scope.test/s", active: true }],
  ]);
  state.executeScript = () => {
    throw new Error("must not reach the page on an out-of-scope host");
  };

  for (const [tool, args] of [
    ["snapshot", {}],
    ["click", { selector: "body" }],
    ["type", { text: "x", selector: "input" }],
    ["screenshot", {}],
  ]) {
    const result = await runBrowserTool(tool, args);
    assert.equal(result.ok, false, `${tool} must be refused`);
    assert.equal(result.code, "HOST_NOT_IN_ALLOWLIST", `${tool} must report why`);
  }
});

test("a refusal names the host but never the forbidden URL", async () => {
  // The refused page is by definition one the caller may not see. This message
  // goes back to the agent AND into activity history, so an out-of-scope OAuth
  // callback must not hand over its query string on the way out.
  state.settings = { groupTitle: "Executor", accessMode: "limited", allowedHosts: ["example.com"] };
  state.tabs = new Map([
    [
      1,
      {
        id: 1,
        groupId: 11,
        windowId: 1,
        url: "https://bank.test/oauth/callback?code=SUPERSECRET&state=x",
        active: true,
      },
    ],
  ]);

  const result = await runBrowserTool("snapshot", {});
  assert.equal(result.ok, false);
  assert.equal(result.code, "HOST_NOT_IN_ALLOWLIST");
  assert.doesNotMatch(result.error, /SUPERSECRET/);
  assert.doesNotMatch(result.error, /oauth\/callback/);
  assert.match(result.error, /bank\.test/);
});

test("allows the implicit active tab when it is inside the allowlist", async () => {
  state.settings = { groupTitle: "Executor", accessMode: "limited", allowedHosts: ["example.test"] };
  state.tabs = new Map([
    [1, { id: 1, groupId: 11, windowId: 1, url: "https://app.example.test/ok", active: true }],
  ]);
  state.executeScript = () => [
    { frameId: 0, result: { url: "https://app.example.test/ok", title: "ok", nodes: [] } },
  ];

  const result = await runBrowserTool("snapshot", {});
  assert.equal(result.ok, true);
});

test("reports an out-of-group tab as denied rather than missing", async () => {
  const result = await runBrowserTool("snapshot", { tabId: 7 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "TAB_OUTSIDE_EXECUTOR_GROUP");
});

test("migrates one existing legacy Executor group to owned storage", async () => {
  state.storedGroupId = null;
  state.groupMigrated = false;

  const result = await runBrowserTool("tabs.list", {});

  assert.equal(result.ok, true);
  assert.equal(result.tabs.length, 1);
  assert.equal(state.storedGroupId, 11);
  assert.equal(state.groupMigrated, true);
});

test("submits a form exactly once", async () => {
  let requestSubmitCalls = 0;
  let submitCalls = 0;
  const form = {
    requestSubmit() {
      requestSubmitCalls += 1;
    },
    submit() {
      submitCalls += 1;
    },
  };
  const element = {
    value: "",
    isContentEditable: false,
    tagName: "INPUT",
    focus() {},
    dispatchEvent() {},
    closest() {
      return form;
    },
  };
  globalThis.document = {
    activeElement: element,
    body: {},
    querySelector() {
      return element;
    },
  };
  globalThis.Event = class {};
  globalThis.KeyboardEvent = class {};
  state.executeScript = ({ func, args }) => [{ result: func(...args) }];

  const result = await runBrowserTool("type", {
    tabId: 1,
    selector: "#query",
    text: "executor",
    submit: true,
  });

  assert.equal(result.ok, true);
  assert.equal(requestSubmitCalls, 1);
  assert.equal(submitCalls, 0);
});

test("uses the selector cached by snapshot for node-index clicks", async () => {
  let call = 0;
  let clickedSelector = null;
  state.executeScript = ({ func, args }) => {
    call += 1;
    if (call === 1) {
      return [{ result: { url: "https://example.test", nodes: [{ selector: "#save", x: 4, y: 5 }] } }];
    }
    globalThis.document = {
      querySelector(selector) {
        clickedSelector = selector;
        return {
          tagName: "BUTTON",
          innerText: "Save",
          scrollIntoView() {},
          focus() {},
          click() {},
        };
      },
      elementFromPoint() {
        return null;
      },
    };
    return [{ result: func(...args) }];
  };

  await runBrowserTool("snapshot", { tabId: 1 });
  const result = await runBrowserTool("click", { tabId: 1, nodeIndex: 0 });

  assert.equal(result.ok, true);
  assert.equal(clickedSelector, "#save");
});

test("returns the complete screenshot data URL", async () => {
  const result = await runBrowserTool("screenshot", { tabId: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.dataUrl, state.captureDataUrl);
});

test("type rejects restricted chrome URLs", async () => {
  state.tabs.set(1, {
    id: 1,
    groupId: 11,
    windowId: 1,
    url: "chrome://settings",
    active: true,
  });
  const result = await runBrowserTool("type", { tabId: 1, text: "x" });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /Restricted/i);
});

test("navigate clears snapshot handles for the tab", async () => {
  let call = 0;
  state.executeScript = ({ func, args }) => {
    call += 1;
    if (call === 1) {
      return [
        {
          result: {
            url: "https://example.test",
            nodes: [{ selector: "#save", x: 4, y: 5 }],
          },
        },
      ];
    }
    return [{ result: { ok: true, tag: "button", text: "Save" } }];
  };

  await runBrowserTool("snapshot", { tabId: 1 });
  await runBrowserTool("navigate", { tabId: 1, url: "https://example.test/next" });
  state.tabs.get(1).url = "https://example.test/next";
  // click-by-index should fail after navigation cleared cache
  state.executeScript = () => {
    throw new Error("should not execute after expired handle");
  };
  const result = await runBrowserTool("click", { tabId: 1, nodeIndex: 0 });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /Snapshot handle expired/i);
});

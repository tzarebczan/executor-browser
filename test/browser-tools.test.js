import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const state = {
  groupId: 11,
  storedGroupId: 11,
  groupMigrated: true,
  tabs: new Map(),
  executeScript: null,
  captureDataUrl: "data:image/jpeg;base64,full-image-data",
};

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (key === "settings") return { settings: { groupTitle: "Executor" } };
        if (Array.isArray(key)) {
          return {
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
    async create({ url, active }) {
      const tab = { id: 20, groupId: -1, windowId: 1, url, active };
      state.tabs.set(tab.id, tab);
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
  state.tabs = new Map([
    [1, { id: 1, groupId: 11, windowId: 1, url: "https://example.test", active: true }],
    [7, { id: 7, groupId: 99, windowId: 1, url: "https://private.test", active: false }],
  ]);
  state.executeScript = () => {
    throw new Error("unexpected script execution");
  };
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

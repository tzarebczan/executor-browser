import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

let settings;
let session;

globalThis.chrome = {
  storage: {
    local: {
      async get() {
        return { settings, ...(session ? { browserControlSession: session } : {}) };
      },
      async set(value) {
        if (value.browserControlSession) session = value.browserControlSession;
      },
      async remove(key) {
        if (key === "browserControlSession") session = null;
      },
    },
  },
};

const { assertToolAccess, getAccessState, hostAllowed, startControlSession } = await import(
  "../extension/lib/access-policy.js"
);

beforeEach(() => {
  settings = { accessMode: "limited", allowedHosts: ["example.com"], sessionMinutes: 30 };
  session = null;
});

test("Limited mode restricts control to the owned group and configured hosts", async () => {
  await assertToolAccess({
    tool: "snapshot",
    groupId: 4,
    tab: { id: 1, groupId: 4, url: "https://app.example.com/path" },
  });
  await assert.rejects(
    assertToolAccess({
      tool: "snapshot",
      groupId: 4,
      tab: { id: 2, groupId: 7, url: "https://app.example.com" },
    }),
    /Executor group/,
  );
  assert.equal(hostAllowed("https://notexample.com", ["example.com"]), false);
});

test("Full mode requires an active expiring session and ignores Limited host scope", async () => {
  settings.accessMode = "full";
  await assert.rejects(
    assertToolAccess({
      tool: "snapshot",
      groupId: 4,
      tab: { id: 2, groupId: 7, url: "https://private.test" },
    }),
    /Start a control session/,
  );
  await startControlSession();
  assert.equal((await getAccessState()).sessionActive, true);
  await assertToolAccess({
    tool: "snapshot",
    groupId: 4,
    tab: { id: 2, groupId: 7, url: "https://private.test" },
  });
});

test("Advanced mode requires both its toggle and a control session", async () => {
  await assert.rejects(
    assertToolAccess({ tool: "evaluate", advanced: true }),
    /Advanced mode is disabled/,
  );
  settings.advancedMode = true;
  await assert.rejects(
    assertToolAccess({ tool: "evaluate", advanced: true }),
    /Start a control session/,
  );
});

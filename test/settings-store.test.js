import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

/**
 * A storage double that makes the interleaving real.
 *
 * `chrome.storage.local` is asynchronous, so a read-modify-write pair can be
 * suspended between its read and its write while another one runs to
 * completion. Awaiting a microtask on every call reproduces that ordering
 * deterministically instead of hoping for it.
 */
const store = {};

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        await null;
        const names = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const name of names) {
          if (name in store) out[name] = store[name];
        }
        return out;
      },
      async set(value) {
        await null;
        Object.assign(store, value);
      },
      async remove(key) {
        await null;
        delete store[key];
      },
    },
  },
};

const {
  ACTIVITY_KEY,
  SETTINGS_KEY,
  clearActivity,
  getActivity,
  getSettings,
  pushActivity,
  removeActivityEntry,
  setSettings,
} = await import("../extension/lib/settings-store.js");

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
});

test("an activity write cannot revert a security setting made alongside it", async () => {
  await setSettings({ accessMode: "full", advancedMode: true });

  // The log append and the tightening overlap: both start from "full".
  const appending = pushActivity({ kind: "browser-use", message: "agent clicked" });
  const tightening = setSettings({ accessMode: "limited", advancedMode: false });
  await Promise.all([appending, tightening]);

  const settings = await getSettings();
  assert.equal(settings.accessMode, "limited");
  assert.equal(settings.advancedMode, false);
  assert.equal((await getActivity()).length, 1);
});

test("concurrent settings writes both survive", async () => {
  await setSettings({ accessMode: "full" });
  await Promise.all([
    setSettings({ allowedHosts: ["example.com"] }),
    setSettings({ accessMode: "limited" }),
  ]);

  const settings = await getSettings();
  assert.equal(settings.accessMode, "limited");
  assert.deepEqual(settings.allowedHosts, ["example.com"]);
});

test("concurrent activity appends do not drop each other", async () => {
  await Promise.all(
    Array.from({ length: 10 }, (_unused, index) =>
      pushActivity({ id: `e${index}`, kind: "tab", message: `event ${index}` }),
    ),
  );
  const activity = await getActivity();
  assert.equal(activity.length, 10);
  assert.deepEqual(
    [...activity.map((entry) => entry.id)].sort(),
    Array.from({ length: 10 }, (_unused, index) => `e${index}`).sort(),
  );
});

test("settings never carry the activity log, however it arrives", async () => {
  store[SETTINGS_KEY] = { accessMode: "limited", activity: [{ id: "legacy" }] };
  const settings = await getSettings();
  assert.equal(settings.activity, undefined);

  await setSettings({ activity: [{ id: "sneaky" }] });
  assert.equal(store[SETTINGS_KEY].activity, undefined);
});

test("an existing log is migrated out of the settings blob on first read", async () => {
  store[SETTINGS_KEY] = { accessMode: "full", activity: [{ id: "old", message: "before" }] };

  const activity = await getActivity();
  assert.deepEqual(activity, [{ id: "old", message: "before" }]);
  assert.deepEqual(store[ACTIVITY_KEY], [{ id: "old", message: "before" }]);

  // Migration must not disturb the settings it was living in.
  assert.equal((await getSettings()).accessMode, "full");
});

test("the log is capped so it cannot grow without bound", async () => {
  for (let index = 0; index < 85; index += 1) {
    await pushActivity({ id: `e${index}`, message: `event ${index}` });
  }
  const activity = await getActivity();
  assert.equal(activity.length, 80);
  assert.equal(activity[0].id, "e84");
});

test("a legacy checkbox survives a later write that does not mention developer tools", async () => {
  store[SETTINGS_KEY] = { advancedMode: true, executorUrl: "https://saved.example" };

  await setSettings({ connectionName: "desktop" });

  const settings = await getSettings();
  assert.equal(settings.cdpMode, "session");
  assert.equal(settings.advancedMode, true);
  assert.equal(settings.connectionName, "desktop");
  assert.equal(store[SETTINGS_KEY].cdpMode, "session");
});

test("an explicit always-on choice survives saving the address", async () => {
  await setSettings({ cdpMode: "always" });
  await setSettings({ executorUrl: "https://saved.example" });

  const settings = await getSettings();
  assert.equal(settings.cdpMode, "always");
  assert.equal(settings.advancedMode, true);
});

test("entries can be removed individually or all at once", async () => {
  await pushActivity({ id: "keep", message: "keep" });
  await pushActivity({ id: "drop", message: "drop" });

  const afterRemove = await removeActivityEntry("drop");
  assert.deepEqual(
    afterRemove.map((entry) => entry.id),
    ["keep"],
  );

  assert.deepEqual(await clearActivity(), []);
  assert.deepEqual(await getActivity(), []);
});

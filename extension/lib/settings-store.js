/**
 * Persisted extension state: settings, and the activity log.
 *
 * The two are stored under separate `chrome.storage.local` keys, and writes to
 * each are serialised.
 *
 * They used to share one `settings` object. `chrome.storage.local.set` replaces
 * a key wholesale, so every appended activity event rewrote the security
 * settings sitting next to it. An event that started before the user tightened
 * access would finish by writing back the looser values it had read, the
 * activity log could silently undo a security change. Separating the keys makes
 * that impossible rather than unlikely, and the write queue closes the same race
 * between two concurrent settings writes.
 */

import { ACCESS_DEFAULTS, normalizeCdpMode } from "./access-policy.js";
import { modernizeActivity } from "./activity.js";

export const SETTINGS_KEY = "settings";
export const ACTIVITY_KEY = "activity";
export const MAX_ACTIVITY = 80;

export const DEFAULTS = Object.freeze({
  executorUrl: "",
  executorApiKey: "",
  registeredAt: 0,
  mode: "existing", // existing | extension-only (UI preference only)
  groupTitle: "Executor",
  groupColor: "blue",
  /** Display name for this browser; also the preferred connection name on first connect. */
  connectionLabel: "",
  /** Catalog connection Executor assigned (`desktop`, `brave`, …). */
  connectionName: "",
  ...ACCESS_DEFAULTS,
});

/**
 * Serialise writes to one storage key so two read-modify-write pairs cannot
 * interleave and drop each other's changes.
 */
function makeWriteQueue() {
  let tail = Promise.resolve();
  return (work) => {
    const run = tail.then(work);
    // Keep the chain alive after a rejection; the caller still sees the error.
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

const writeSettings = makeWriteQueue();
const writeActivity = makeWriteQueue();

/**
 * `cdpMode` is the stored choice. Defaults include `"off"`, so merging them
 * before a write would freeze that default over an older install that only
 * stored `advancedMode: true`. A write that does not mention developer tools
 * keeps the choice already on disk.
 */
function resolveCdpMode(raw, partial) {
  if (partial?.cdpMode === "always" || partial?.cdpMode === "session" || partial?.cdpMode === "off") {
    return partial.cdpMode;
  }
  if (partial && Object.hasOwn(partial, "advancedMode")) {
    if (partial.advancedMode === false && raw?.cdpMode !== "always") return "off";
    if (partial.advancedMode === true && (raw?.cdpMode === undefined || raw?.cdpMode === "off")) {
      return "session";
    }
  }
  return normalizeCdpMode(raw);
}

export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = stored[SETTINGS_KEY] || {};
  const cdpMode = normalizeCdpMode(raw);
  const merged = { ...DEFAULTS, ...raw, cdpMode, advancedMode: cdpMode !== "off" };
  // Older installs kept the log here. It is read from its own key now.
  delete merged.activity;
  return merged;
}

export async function setSettings(partial) {
  return writeSettings(async () => {
    // Re-read the raw object inside the queue. Reading the merged defaults
    // would write cdpMode "off" over a legacy checkbox.
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const raw = { ...(stored[SETTINGS_KEY] || {}) };
    delete raw.activity;
    const cdpMode = resolveCdpMode(raw, partial);
    const next = {
      ...DEFAULTS,
      ...raw,
      ...partial,
      cdpMode,
      advancedMode: cdpMode !== "off",
    };
    delete next.activity;
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  });
}

/** Read only. Never writes, so it is safe to call from inside the write queue. */
async function readActivity() {
  const stored = await chrome.storage.local.get([ACTIVITY_KEY, SETTINGS_KEY]);
  const raw = Array.isArray(stored[ACTIVITY_KEY])
    ? stored[ACTIVITY_KEY]
    : Array.isArray(stored[SETTINGS_KEY]?.activity)
      ? stored[SETTINGS_KEY].activity
      : [];
  return modernizeActivity(raw).entries;
}

export async function getActivity() {
  // The migrating write goes through the same queue as every other write.
  // Doing it inline would let a slow first read land its legacy copy *after* a
  // queued clear had completed, resurrecting history the user just deleted.
  return writeActivity(async () => {
    const stored = await chrome.storage.local.get([ACTIVITY_KEY, SETTINGS_KEY]);
    const own = Array.isArray(stored[ACTIVITY_KEY]) ? stored[ACTIVITY_KEY] : null;
    const legacy = Array.isArray(stored[SETTINGS_KEY]?.activity)
      ? stored[SETTINGS_KEY].activity
      : [];
    const source = own ?? legacy;
    if (!own && source.length === 0) return [];

    // Written back rather than rewritten per read: the old wording is in
    // storage, and healing it once means a later read cannot resurrect it.
    const { entries, changed } = modernizeActivity(source);
    if (changed || !own) await chrome.storage.local.set({ [ACTIVITY_KEY]: entries });
    return entries;
  });
}

export async function pushActivity(entry) {
  return writeActivity(async () => {
    const current = await readActivity();
    const next = [
      {
        id: entry.id || `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        t: Date.now(),
        ...entry,
      },
      ...current,
    ].slice(0, MAX_ACTIVITY);
    await chrome.storage.local.set({ [ACTIVITY_KEY]: next });
    return next;
  });
}

export async function clearActivity() {
  return writeActivity(async () => {
    await chrome.storage.local.set({ [ACTIVITY_KEY]: [] });
    return [];
  });
}

export async function removeActivityEntry(id) {
  return writeActivity(async () => {
    const next = (await readActivity()).filter((entry) => entry.id !== id);
    await chrome.storage.local.set({ [ACTIVITY_KEY]: next });
    return next;
  });
}

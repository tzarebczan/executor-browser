const SESSION_KEY = "browserControlSession";

export const ACCESS_DEFAULTS = Object.freeze({
  accessMode: "limited",
  allowedHosts: [],
  advancedMode: false,
  sessionMinutes: 30,
});

function normalizeHosts(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/);
  return [...new Set(values.map((host) => String(host).trim().toLowerCase()).filter(Boolean))];
}

export async function getAccessState() {
  const stored = await chrome.storage.local.get(["settings", SESSION_KEY]);
  const settings = { ...ACCESS_DEFAULTS, ...(stored.settings || {}) };
  settings.accessMode = settings.accessMode === "full" ? "full" : "limited";
  settings.allowedHosts = normalizeHosts(settings.allowedHosts);
  settings.sessionMinutes = Math.max(5, Math.min(240, Number(settings.sessionMinutes) || 30));

  let session = stored[SESSION_KEY] || null;
  if (session && Number(session.expiresAt) <= Date.now()) {
    await chrome.storage.local.remove(SESSION_KEY);
    session = null;
  }
  const sessionActive = Boolean(session && session.mode === settings.accessMode);
  return { settings, session: sessionActive ? session : null, sessionActive };
}

export async function startControlSession(actor = "User") {
  const { settings } = await getAccessState();
  const startedAt = Date.now();
  const session = {
    id: `control-${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    mode: settings.accessMode,
    actor,
    startedAt,
    expiresAt: startedAt + settings.sessionMinutes * 60_000,
  };
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  return session;
}

export async function endControlSession() {
  await chrome.storage.local.remove(SESSION_KEY);
}

export function hostAllowed(urlValue, allowedHosts) {
  if (!allowedHosts?.length) return true;
  try {
    const host = new URL(urlValue).hostname.toLowerCase();
    return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

export async function assertToolAccess({ tool, tab, groupId, advanced = false }) {
  const state = await getAccessState();
  if (advanced) {
    if (!state.settings.advancedMode) {
      throw new Error("Advanced mode is disabled in Executor Browser settings");
    }
    if (!state.sessionActive) {
      throw new Error("Start a control session before using Advanced browser tools");
    }
  }
  if (state.settings.accessMode === "full" && !state.sessionActive) {
    throw new Error("Full access is paused. Start a control session in Executor Browser.");
  }
  if (!tab) return state;
  const isOwned = Number.isInteger(groupId) && tab.groupId === groupId;
  if (state.settings.accessMode === "limited" && !isOwned) {
    throw new Error("Limited access only permits tabs in the Executor group");
  }
  if (
    state.settings.accessMode === "limited" &&
    !hostAllowed(tab.url, state.settings.allowedHosts)
  ) {
    throw new Error(`Host is outside the Limited access scope: ${tab.url || "unknown"}`);
  }
  return state;
}

export async function accessAdvertisement() {
  const state = await getAccessState();
  return {
    mode: state.settings.accessMode,
    sessionActive: state.sessionActive,
    advanced: Boolean(state.settings.advancedMode && state.sessionActive),
    allowedHosts: state.settings.allowedHosts,
    expiresAt: state.session?.expiresAt || null,
  };
}

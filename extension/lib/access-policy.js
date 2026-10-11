const SESSION_KEY = "browserControlSession";

/**
 * A refusal by the access policy, distinct from "the tab does not exist".
 * Callers surface `code` so agents can tell a permission problem from a
 * missing target instead of retrying against the wrong cause.
 */
export class BrowserAccessError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BrowserAccessError";
    this.code = code;
  }
}

export const ACCESS_CODES = Object.freeze({
  advancedDisabled: "ADVANCED_MODE_DISABLED",
  sessionRequired: "CONTROL_SESSION_REQUIRED",
  outsideGroup: "TAB_OUTSIDE_EXECUTOR_GROUP",
  hostNotAllowed: "HOST_NOT_IN_ALLOWLIST",
});

export const ACCESS_DEFAULTS = Object.freeze({
  accessMode: "limited",
  allowedHosts: [],
  advancedMode: false,
  /**
   * Developer tools (CDP).
   * off — debugger stays detached.
   * session — on only during an access window.
   * always — on whenever this browser is connected. No window to start.
   */
  cdpMode: "off",
  sessionMinutes: 30,
});

/** Older installs stored only the checkbox. That maps to a window, not always-on. */
export function normalizeCdpMode(settings) {
  if (settings?.cdpMode === "always" || settings?.cdpMode === "session" || settings?.cdpMode === "off") {
    return settings.cdpMode;
  }
  return settings?.advancedMode ? "session" : "off";
}

function normalizeHosts(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/);
  return [...new Set(values.map((host) => String(host).trim().toLowerCase()).filter(Boolean))];
}

export async function getAccessState() {
  const stored = await chrome.storage.local.get(["settings", SESSION_KEY]);
  const storedSettings = stored.settings || {};
  const settings = { ...ACCESS_DEFAULTS, ...storedSettings };
  settings.accessMode = settings.accessMode === "full" ? "full" : "limited";
  settings.allowedHosts = normalizeHosts(settings.allowedHosts);
  // Defaults include cdpMode "off". Reading that merged value would hide an
  // older install that only stored the checkbox.
  settings.cdpMode = normalizeCdpMode(storedSettings);
  settings.advancedMode = settings.cdpMode !== "off";
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

/** The host alone, for messages that must not carry a path or query string. */
export function hostLabel(urlValue) {
  try {
    return new URL(urlValue).hostname.toLowerCase() || "unknown";
  } catch {
    return "unknown";
  }
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
    if (state.settings.cdpMode === "off") {
      throw new BrowserAccessError(
        "Advanced mode is disabled in Executor Browser settings",
        ACCESS_CODES.advancedDisabled,
      );
    }
    // Always-on is the setting. A window is only required when the user asked
    // for developer tools for a limited time.
    if (state.settings.cdpMode !== "always" && !state.sessionActive) {
      throw new BrowserAccessError(
        "Start a control session before using Advanced browser tools",
        ACCESS_CODES.sessionRequired,
      );
    }
  }
  if (state.settings.accessMode === "full" && !state.sessionActive) {
    throw new BrowserAccessError(
      "Full access is paused. Start a control session in Executor Browser.",
      ACCESS_CODES.sessionRequired,
    );
  }
  if (!tab) return state;
  const isOwned = Number.isInteger(groupId) && tab.groupId === groupId;
  if (state.settings.accessMode === "limited" && !isOwned) {
    throw new BrowserAccessError(
      "Limited access only permits tabs in the Executor group",
      ACCESS_CODES.outsideGroup,
    );
  }
  // Applies to every resolved tab, including the implicit active one, a tab
  // that drifted off the allowlist must not stay controllable just because the
  // caller omitted `tabId`.
  if (
    state.settings.accessMode === "limited" &&
    !hostAllowed(tab.url, state.settings.allowedHosts)
  ) {
    // Host only. The refused URL is by definition one the caller is not allowed
    // to see, and this message travels to the agent and into activity history:
    // a denied OAuth callback would otherwise hand over its query string.
    throw new BrowserAccessError(
      `Host is outside the Limited access scope: ${hostLabel(tab.url)}`,
      ACCESS_CODES.hostNotAllowed,
    );
  }
  return state;
}

export async function accessAdvertisement() {
  const state = await getAccessState();
  return {
    mode: state.settings.accessMode,
    sessionActive: state.sessionActive,
    cdpMode: state.settings.cdpMode,
    advanced: state.settings.cdpMode === "always" || (state.settings.cdpMode === "session" && state.sessionActive),
    allowedHosts: state.settings.allowedHosts,
    expiresAt: state.session?.expiresAt || null,
  };
}

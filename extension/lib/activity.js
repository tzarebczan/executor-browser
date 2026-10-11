import { redactUrl } from "./redact.js";

const MAX_DETAIL_LENGTH = 160;

const clean = (value, max = MAX_DETAIL_LENGTH) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/**
 * A readable name for the client that made the call.
 *
 * This is the client's own claim about itself: any MCP client can send any
 * name, so the result must never be shown as a verified identity. The
 * authenticated identity is `caller.principal`, which Executor derives from
 * the request's credentials, see `attributionFrom`.
 */
export function displayActor(caller) {
  const raw = clean(caller?.name, 60);
  if (!raw || raw === "unknown") return "Agent via Executor";
  if (/codex/i.test(raw)) return "Codex";
  if (/claude/i.test(raw)) return "Claude";
  if (/grok/i.test(raw)) return "Grok";
  return raw;
}

/**
 * Split what a caller asserted from what Executor authenticated.
 *
 * The two are kept apart so the history can say "Claude, self-reported, on
 * this account" rather than implying the browser confirmed which agent it was
 * talking to. It never did.
 */
export function attributionFrom(caller) {
  const principal = clean(caller?.principal, 100);
  return {
    actor: displayActor(caller),
    /** Always true: the name is the client's own claim, whoever sent it. */
    actorClaimed: true,
    principal,
  };
}

function operationSummary(tool, args, result) {
  switch (tool) {
    case "ping":
      return { summary: "Checked browser connection", detail: "Agent control channel" };
    case "tabs.list":
    case "list_tabs":
      return {
        summary: "Listed controlled tabs",
        detail: `${result?.tabs?.length ?? 0} tab${result?.tabs?.length === 1 ? "" : "s"}`,
      };
    case "tabs.open":
    case "open_tab":
      return { summary: "Opened a controlled tab", detail: clean(redactUrl(args?.url)) };
    case "navigate":
      return { summary: "Navigated a controlled tab", detail: clean(redactUrl(args?.url)) };
    case "tabs.activate":
      return { summary: "Activated a controlled tab", detail: `Tab ${args?.tabId ?? ""}`.trim() };
    case "tabs.close":
      return { summary: "Closed a controlled tab", detail: `Tab ${args?.tabId ?? ""}`.trim() };
    case "back":
    case "forward":
    case "reload":
      return { summary: `${tool[0].toUpperCase()}${tool.slice(1)} on a controlled tab`, detail: "" };
    case "snapshot":
    case "take_snapshot":
      return {
        summary: "Inspected page structure",
        detail: Number.isFinite(result?.snapshot?.nodes?.length)
          ? `${result.snapshot.nodes.length} accessible nodes`
          : "Accessibility snapshot",
      };
    case "click": {
      const target = args?.selector
        ? `Selector ${clean(args.selector, 80)}`
        : Number.isInteger(args?.nodeIndex)
          ? `Snapshot node ${args.nodeIndex}`
          : Number.isFinite(args?.x) && Number.isFinite(args?.y)
            ? `Page coordinates ${args.x}, ${args.y}`
            : "Page element";
      return { summary: "Clicked a page element", detail: target };
    }
    case "type":
    case "input_text":
      return {
        summary: args?.submit ? "Typed into a page and submitted" : "Typed into a page",
        detail: args?.selector ? `Field ${clean(args.selector, 80)}` : "Focused field (text not retained)",
      };
    case "dblclick":
    case "hover":
    case "focus":
    case "press":
    case "select":
    case "check":
    case "scroll":
      return { summary: `Used ${tool} on a page`, detail: clean(args?.selector || args?.key || "") };
    case "screenshot":
    case "capture_screenshot":
      return { summary: "Captured a page screenshot", detail: "Image data not retained in history" };
    case "find":
    case "wait":
      return {
        summary: tool === "find" ? "Found page elements" : "Waited for page state",
        detail: clean(args?.selector || args?.text || redactUrl(args?.url || "")),
      };
    case "upload":
      return { summary: "Attached files to a page", detail: `${args?.files?.length || 0} file(s); contents not retained` };
    case "downloads.list":
      return { summary: "Listed browser downloads", detail: `${result?.downloads?.length || 0} item(s)` };
    case "console.list":
    case "network.list":
      return { summary: `Inspected ${tool.startsWith("console") ? "console" : "network"} activity`, detail: "Advanced session" };
    case "evaluate":
      return { summary: "Evaluated page JavaScript", detail: "Expression and result not retained" };
    case "pdf":
      return { summary: "Printed page to PDF", detail: "PDF data not retained" };
    default:
      return { summary: clean(tool, 80) || "Used a browser tool", detail: "" };
  }
}

function targetFrom(args, result) {
  const tab = result?.tab || {};
  return {
    id: tab.id ?? result?.tabId ?? args?.tabId ?? args?.tab_id ?? null,
    title: clean(tab.title, 100),
    // History is persisted to chrome.storage.local, so the URL is reduced the
    // same way capture buffers are, a signed URL or OAuth callback must not be
    // written out whole just because a tool happened to touch it.
    url: clean(redactUrl(tab.url || result?.snapshot?.url || args?.url || ""), 300),
  };
}

/**
 * Rewrite the mechanism's old name out of history that was already written.
 *
 * Renaming the strings in source only changed what gets written *next*.
 * Activity is persisted, so every entry recorded before the rename kept saying
 * "Reverse bridge session bbs_msfp..." in the feed, and reinstalling the
 * extension did not help because the storage survives it. The user could clear
 * the log, but that trades their history for the fix.
 *
 * Rules are matched against the text rather than an entry version, because the
 * entries carry no version and never did. Anything still naming the transport
 * after the known rules is caught by the last one: a wrong-but-neutral summary
 * beats leaking an internal name into a feed people read.
 */
const RETIRED_PHRASING = [
  [/^reverse bridge session\b.*/i, "Agent control connected"],
  [/^reverse channel unavailable\b.*/i, "Agent control unavailable on this Executor"],
  [/^reverse session open failed\b.*/i, "Could not open agent control; retrying shortly"],
  [/^reverse (bridge|channel|session) (closed|ended|stopped)\b.*/i, "Agent control disconnected"],
  [/^extension reverse bridge$/i, "Agent control channel"],
  [/reverse|bridge/i, "Agent control activity"],
];

function modernizeText(value) {
  if (typeof value !== "string" || !value) return value;
  for (const [pattern, replacement] of RETIRED_PHRASING) {
    if (pattern.test(value)) return replacement;
  }
  return value;
}

/**
 * @returns the entry unchanged when nothing matched, so a no-op migration can
 * be detected by identity and skipped without rewriting storage.
 */
export function modernizeActivityEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  let changed = false;
  const next = { ...entry };
  for (const field of ["message", "summary", "detail"]) {
    const updated = modernizeText(entry[field]);
    if (updated !== entry[field]) {
      next[field] = updated;
      changed = true;
    }
  }
  return changed ? next : entry;
}

export function modernizeActivity(entries) {
  if (!Array.isArray(entries)) return { entries: [], changed: false };
  let changed = false;
  const next = entries.map((entry) => {
    const updated = modernizeActivityEntry(entry);
    if (updated !== entry) changed = true;
    return updated;
  });
  return { entries: changed ? next : entries, changed };
}

export function browserActivityEntry(job, result, startedAt, endedAt = Date.now()) {
  const tool = clean(job?.tool || job?.name || job?.method, 80);
  const args = job?.args || job?.arguments || job?.params || {};
  const { actor, actorClaimed, principal } = attributionFrom(job?.caller);
  const operation = operationSummary(tool, args, result);
  const ok = Boolean(result?.ok);

  return {
    id: clean(job?.id || job?.jobId, 100) || `use-${endedAt}-${Math.random().toString(36).slice(2, 8)}`,
    t: endedAt,
    startedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    kind: "browser-use",
    actor,
    actorClaimed,
    principal,
    actorVersion: clean(job?.caller?.version, 40),
    tool,
    summary: operation.summary,
    detail: operation.detail,
    target: targetFrom(args, result),
    outcome: ok ? "ok" : "error",
    error: ok ? "" : clean(result?.error || "Browser tool failed"),
    message: `${actor}: ${operation.summary}`,
  };
}

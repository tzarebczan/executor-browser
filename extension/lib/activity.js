const MAX_DETAIL_LENGTH = 160;

const clean = (value, max = MAX_DETAIL_LENGTH) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

export function displayActor(caller) {
  const raw = clean(caller?.name, 60);
  if (!raw) return "Agent via Executor";
  if (/codex/i.test(raw)) return "Codex";
  if (/claude/i.test(raw)) return "Claude";
  if (/grok/i.test(raw)) return "Grok";
  return raw;
}

function operationSummary(tool, args, result) {
  switch (tool) {
    case "ping":
      return { summary: "Checked browser connection", detail: "Extension reverse bridge" };
    case "tabs.list":
    case "list_tabs":
      return {
        summary: "Listed controlled tabs",
        detail: `${result?.tabs?.length ?? 0} tab${result?.tabs?.length === 1 ? "" : "s"}`,
      };
    case "tabs.open":
    case "open_tab":
      return { summary: "Opened a controlled tab", detail: clean(args?.url) };
    case "navigate":
      return { summary: "Navigated a controlled tab", detail: clean(args?.url) };
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
        detail: clean(args?.selector || args?.text || args?.url || ""),
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
    url: clean(tab.url || result?.snapshot?.url || args?.url, 300),
  };
}

export function browserActivityEntry(job, result, startedAt, endedAt = Date.now()) {
  const tool = clean(job?.tool || job?.name || job?.method, 80);
  const args = job?.args || job?.arguments || job?.params || {};
  const actor = displayActor(job?.caller);
  const operation = operationSummary(tool, args, result);
  const ok = Boolean(result?.ok);

  return {
    id: clean(job?.id || job?.jobId, 100) || `use-${endedAt}-${Math.random().toString(36).slice(2, 8)}`,
    t: endedAt,
    startedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    kind: "browser-use",
    actor,
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

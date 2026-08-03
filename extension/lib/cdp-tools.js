const attachedTabs = new Set();
const consoleByTab = new Map();
const networkByTab = new Map();
const dialogByTab = new Map();
const MAX_EVENTS = 500;

function append(map, tabId, value) {
  const items = map.get(tabId) || [];
  items.push(value);
  if (items.length > MAX_EVENTS) items.splice(0, items.length - MAX_EVENTS);
  map.set(tabId, items);
}

async function send(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

export async function ensureDebugger(tabId) {
  if (!chrome.debugger?.attach) throw new Error("Chrome debugger API is unavailable");
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.add(tabId);
  await Promise.all([
    send(tabId, "Runtime.enable"),
    send(tabId, "Log.enable"),
    send(tabId, "Network.enable"),
    send(tabId, "Page.enable"),
  ]);
}

chrome.debugger?.onDetach?.addListener((source) => {
  if (source.tabId != null) attachedTabs.delete(source.tabId);
});

chrome.debugger?.onEvent?.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  if (method === "Runtime.consoleAPICalled") {
    append(consoleByTab, tabId, {
      level: params.type,
      text: (params.args || []).map((arg) => arg.value ?? arg.description ?? arg.type).join(" ").slice(0, 2000),
      timestamp: params.timestamp,
    });
  } else if (method === "Log.entryAdded") {
    append(consoleByTab, tabId, {
      level: params.entry?.level,
      text: String(params.entry?.text || "").slice(0, 2000),
      timestamp: params.entry?.timestamp,
    });
  } else if (method === "Network.requestWillBeSent") {
    append(networkByTab, tabId, {
      requestId: params.requestId,
      method: params.request?.method,
      url: params.request?.url,
      type: params.type,
      timestamp: params.timestamp,
    });
  } else if (method === "Network.responseReceived") {
    const items = networkByTab.get(tabId) || [];
    const request = [...items].reverse().find((item) => item.requestId === params.requestId);
    if (request) {
      request.status = params.response?.status;
      request.mimeType = params.response?.mimeType;
    }
  } else if (method === "Page.javascriptDialogOpening") {
    dialogByTab.set(tabId, { type: params.type, message: String(params.message || "").slice(0, 500) });
  } else if (method === "Page.javascriptDialogClosed") {
    dialogByTab.delete(tabId);
  }
});

export async function runCdpTool(tool, tabId, args = {}) {
  await ensureDebugger(tabId);
  if (tool === "console.list") {
    let messages = consoleByTab.get(tabId) || [];
    if (args.level && args.level !== "all") messages = messages.filter((item) => item.level === args.level);
    if (args.clear) consoleByTab.set(tabId, []);
    return { ok: true, messages };
  }
  if (tool === "network.list") {
    let requests = networkByTab.get(tabId) || [];
    if (args.filter) requests = requests.filter((item) => String(item.url).includes(args.filter));
    requests = requests.slice(-Math.min(500, Number(args.limit) || 100));
    if (args.clear) networkByTab.set(tabId, []);
    return { ok: true, requests };
  }
  if (tool === "dialog.handle") {
    if (!dialogByTab.has(tabId)) return { ok: false, error: "No JavaScript dialog is open" };
    await send(tabId, "Page.handleJavaScriptDialog", { accept: args.accept, promptText: args.promptText });
    return { ok: true, handled: true };
  }
  if (tool === "evaluate") {
    const result = await send(tabId, "Runtime.evaluate", {
      expression: args.expression,
      awaitPromise: args.awaitPromise !== false,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) return { ok: false, error: result.exceptionDetails.text || "Evaluation failed" };
    return { ok: true, value: result.result?.value, type: result.result?.type };
  }
  if (tool === "pdf") {
    const result = await send(tabId, "Page.printToPDF", {
      landscape: Boolean(args.landscape),
      printBackground: args.printBackground !== false,
    });
    return { ok: true, dataBase64: result.data, bytes: Math.floor((result.data?.length || 0) * 0.75), mime: "application/pdf" };
  }
  if (tool === "viewport.set") {
    const deviceScaleFactor = Number(args.deviceScaleFactor) || 1;
    await send(tabId, "Emulation.setDeviceMetricsOverride", {
      width: args.width,
      height: args.height,
      deviceScaleFactor,
      mobile: false,
    });
    return { ok: true, width: args.width, height: args.height, deviceScaleFactor };
  }
  if (tool === "screenshot" && args.fullPage) {
    const metrics = await send(tabId, "Page.getLayoutMetrics");
    const size = metrics.cssContentSize || metrics.contentSize;
    const result = await send(tabId, "Page.captureScreenshot", {
      format: args.format || "png",
      quality: args.format === "jpeg" ? args.quality || 80 : undefined,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
    });
    const mime = args.format === "jpeg" ? "image/jpeg" : "image/png";
    return { ok: true, dataUrl: `data:${mime};base64,${result.data}`, bytes: Math.floor(result.data.length * 0.75), mime };
  }
  return { ok: false, error: `Unsupported Advanced tool: ${tool}` };
}

/* Playground state driver — patches the same IDs sidebar.js drives,
   using the same markup shapes (matrixRow / setup-step / tab-list). */

const $ = (id) => document.getElementById(id);
const device = document.querySelector(".device");

function row(state, label, detail) {
  const icon =
    state === "ok" ? "✓" : state === "run" ? "…" : state === "warn" ? "!" : state === "skip" || state === "off" ? "○" : "✕";
  const pill = detail ? `<span class="mx-pill ${state}">${detail}</span>` : "";
  return `<li class="mx ${state}"><span class="mx-left"><span class="mx-icon">${icon}</span><span class="mx-label">${label}</span></span>${pill}</li>`;
}

function led(id, cls) {
  $(id).className = `led ${cls}`.trim();
}

function stat(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = `sig-v mono ${cls}`.trim();
}

function feed(items) {
  $("activityList").innerHTML = items.length
    ? items
        .map(
          ([msg, when]) =>
            `<li><span class="dot"></span><span>${msg}</span><span class="when">${when}</span></li>`,
        )
        .join("")
    : `<li class="empty">Nothing yet</li>`;
}

function tabs(items) {
  $("tabList").innerHTML = items.length
    ? items
        .map(
          ([title, url]) =>
            `<li><button type="button">${title}<span class="url">${url}</span></button></li>`,
        )
        .join("")
    : `<li class="empty">No agent tabs</li>`;
}

function setup(steps, actions) {
  const banner = $("setupBanner");
  if (!steps) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  $("setupSteps").innerHTML = steps
    .map(
      (s, i) =>
        `<div class="setup-step ${s.done ? "done" : "todo"}"><span class="n">${s.done ? "✓" : i + 1}</span><span>${s.text}</span></div>`,
    )
    .join("");
  $("quickActions").innerHTML = (actions || [])
    .map((a) => `<button type="button" class="primary sm">${a}</button>`)
    .join("");
}

function preview({ shot, url, title, emptyTitle, emptyHint, error }) {
  $("mockShot").hidden = !shot;
  $("previewEmpty").hidden = shot;
  $("previewUrl").textContent = url;
  $("previewTitle").textContent = title;
  if (!shot) {
    $("previewEmptyTitle").textContent = emptyTitle;
    $("previewEmptyHint").textContent = emptyHint;
  }
  $("previewError").hidden = !error;
  $("previewError").textContent = error || "";
  $("previewLocalTag").hidden = Boolean(error);
}

function banner(state, title, sub) {
  $("connBanner").dataset.state = state;
  $("connTitle").textContent = title;
  $("connSub").textContent = sub;
}

function connectTab(label, dotCls) {
  $("connectTabLabel").textContent = label;
  const dot = $("connectTabDot");
  dot.hidden = !dotCls;
  dot.className = `tab-dot ${dotCls === "ok" ? "" : dotCls || ""}`.trim();
}

const CONNECTED_BASE = () => {
  led("executorLed", "live");
  stat("executorStat", "12ms", "ok");
  led("companionLed", "live");
  stat("companionStat", "live", "ok");
  $("headerStatus").textContent = "Connected · reverse";
  connectTab("Connected", "ok");
  setup(null);
  banner("ok", "Connected", "lab-agents…ts.net:8444 · 12ms");
  $("connectMatrix").innerHTML = row("ok", "Reachable", "12ms") + row("ok", "Auth", "verified");
  $("connectForm").classList.add("is-collapsed");
  $("connectedActions").hidden = false;
  $("connectHint").textContent = "";
  $("driveModeTag").className = "mx-tag ok-tag";
  $("connectDriveBlurb").textContent =
    "Path B active — extension reverse session with Executor. No local script.";
  $("connectMatrixOpt").innerHTML =
    row("ok", "Drive path", "session live") + row("ok", "Extension tools", "snapshot·click·type");
  $("useBadge").textContent = "full";
  $("useBadge").className = "badge";
  $("coreTag").textContent = "ok";
  $("coreTag").className = "mx-tag ok-tag";
  $("agentMatrixDrive").innerHTML =
    row("ok", "B · Reverse", "session") +
    row("skip", "C · Native host", "not installed") +
    row("skip", "Legacy companion", "off");
  $("driveBlurb").textContent = "Path B reverse session live — agents can drive via Executor bridge.";
  $("nextHint").textContent = "Connected + reverse browser bridge.";
};

const DISCONNECTED_DRIVE = () => {
  led("companionLed", "");
  stat("companionStat", "off", "warn");
  $("driveModeTag").className = "mx-tag";
  $("connectDriveBlurb").textContent =
    "Connect first. Browser drive uses the extension reverse channel (B) by default.";
  $("connectMatrixOpt").innerHTML =
    row("skip", "Drive path", "connect first") + row("skip", "Extension tools", "—");
  $("connectForm").classList.remove("is-collapsed");
  $("connectedActions").hidden = true;
  $("useBadge").textContent = "setup";
  $("useBadge").className = "badge soft";
  $("coreTag").textContent = "required";
  $("coreTag").className = "mx-tag";
  $("agentMatrixDrive").innerHTML =
    row("skip", "B · Reverse", "idle") +
    row("skip", "C · Native host", "not installed") +
    row("skip", "Legacy companion", "off");
  $("driveBlurb").textContent =
    "Default drive is extension reverse (B). Native host (C) or companion under Advanced.";
};

const STATES = {
  connected: {
    view: "home",
    apply() {
      CONNECTED_BASE();
      led("tabsLed", "live");
      stat("tabStat", "3", "ok");
      $("tabCount").textContent = "3";
      preview({ shot: true, url: "tbd.jiggytom.com/", title: "EggOn — agents" });
      feed([
        ["Reverse session live", "2s"],
        ["API key verified", "12s"],
        ["Opened agent tab", "1m"],
      ]);
      tabs([
        ["EggOn — agents", "tbd.jiggytom.com/"],
        ["EggOn — runs", "tbd.jiggytom.com/runs"],
        ["Docs", "docs.jiggytom.com/executor"],
      ]);
      $("agentMatrixCore").innerHTML =
        row("ok", "Executor", "12ms") + row("ok", "API key", "verified") + row("ok", "Agent tabs", "3");
    },
  },

  "needs-key": {
    view: "connect",
    apply() {
      led("executorLed", "live");
      stat("executorStat", "18ms", "ok");
      led("tabsLed", "");
      stat("tabStat", "0", "warn");
      $("tabCount").textContent = "0";
      $("headerStatus").textContent = "Needs API key";
      connectTab("Connect", "warn");
      DISCONNECTED_DRIVE();
      setup(
        [
          { done: true, text: "Executor reachable" },
          { done: false, text: "Paste API key" },
        ],
        ["Connect…"],
      );
      banner("warn", "Reachable · needs key", "lab-agents…ts.net:8444 · paste personal API key");
      $("connectMatrix").innerHTML = row("ok", "Reachable", "18ms") + row("bad", "Auth", "no key");
      $("connectHint").textContent = "";
      preview({
        shot: false,
        url: "No capture yet",
        title: "—",
        emptyTitle: "Nothing captured",
        emptyHint: "A JPEG for your eyes only — never sent to Executor. Open an agent tab, then Capture.",
      });
      feed([["Executor found at lab-agents…:8444", "5s"]]);
      tabs([]);
      $("agentMatrixCore").innerHTML =
        row("ok", "Executor", "18ms") + row("bad", "API key", "no key") + row("skip", "Agent tabs", "none yet");
      $("nextHint").textContent = "Not connected: paste API key.";
    },
  },

  offline: {
    view: "connect",
    apply() {
      led("executorLed", "fault");
      stat("executorStat", "offline", "bad");
      led("tabsLed", "");
      stat("tabStat", "0", "warn");
      $("tabCount").textContent = "0";
      $("headerStatus").textContent = "Executor offline";
      connectTab("Connect", null);
      DISCONNECTED_DRIVE();
      setup(
        [
          { done: false, text: "Reach Executor (Tailscale)" },
          { done: false, text: "Paste API key" },
        ],
        ["Detect"],
      );
      banner("bad", "Not connected", "Executor offline — join Tailscale or Detect");
      $("connectMatrix").innerHTML = row("bad", "Reachable", "offline") + row("warn", "Auth", "key saved");
      $("connectHint").textContent = "Unreachable — join Tailscale or check the URL.";
      preview({
        shot: false,
        url: "No capture yet",
        title: "—",
        emptyTitle: "Nothing captured",
        emptyHint: "Capture works without Executor — it never leaves this machine.",
      });
      feed([]);
      tabs([]);
      $("agentMatrixCore").innerHTML =
        row("bad", "Executor", "offline") + row("warn", "API key", "key saved") + row("skip", "Agent tabs", "none yet");
      $("nextHint").textContent = "Not connected: Tailscale / Detect.";
    },
  },

  "auth-failed": {
    view: "connect",
    apply() {
      led("executorLed", "live");
      stat("executorStat", "15ms", "ok");
      led("tabsLed", "");
      stat("tabStat", "0", "warn");
      $("tabCount").textContent = "0";
      $("headerStatus").textContent = "Auth failed";
      connectTab("Connect", "warn");
      DISCONNECTED_DRIVE();
      setup(
        [
          { done: true, text: "Executor reachable" },
          { done: false, text: "Connect" },
        ],
        ["Connect…"],
      );
      banner("bad", "Auth failed", "Invalid API key (401) — paste a fresh personal key");
      $("connectMatrix").innerHTML = row("ok", "Reachable", "15ms") + row("bad", "Auth", "invalid key");
      $("connectHint").textContent = "Invalid API key (401/403)";
      preview({
        shot: false,
        url: "No capture yet",
        title: "—",
        emptyTitle: "Nothing captured",
        emptyHint: "A JPEG for your eyes only — never sent to Executor.",
      });
      feed([["Auth failed (401)", "3s"]]);
      tabs([]);
      $("agentMatrixCore").innerHTML =
        row("ok", "Executor", "15ms") + row("bad", "API key", "invalid") + row("skip", "Agent tabs", "none yet");
      $("nextHint").textContent = "Not connected: auth failed or verifying.";
    },
  },

  "empty-tabs": {
    view: "tabs",
    apply() {
      CONNECTED_BASE();
      led("tabsLed", "");
      stat("tabStat", "0", "warn");
      $("tabCount").textContent = "0";
      preview({
        shot: false,
        url: "No capture yet",
        title: "—",
        emptyTitle: "Nothing captured",
        emptyHint: "A JPEG for your eyes only — never sent to Executor. Open an agent tab, then Capture.",
      });
      feed([
        ["Reverse session live", "10s"],
        ["API key verified", "20s"],
      ]);
      tabs([]);
      $("agentMatrixCore").innerHTML =
        row("ok", "Executor", "12ms") + row("ok", "API key", "verified") + row("skip", "Agent tabs", "none yet");
    },
  },

  "capture-error": {
    view: "home",
    apply() {
      CONNECTED_BASE();
      led("tabsLed", "live");
      stat("tabStat", "1", "ok");
      $("tabCount").textContent = "1";
      preview({
        shot: false,
        url: "—",
        title: "Capture failed",
        emptyTitle: "Capture failed",
        emptyHint: "Tab not visible — bring the agent Chrome window to front, then Capture.",
        error: "Tab not visible",
      });
      feed([
        ["Capture failed: window minimized", "4s"],
        ["Reverse session live", "1m"],
      ]);
      tabs([["EggOn — agents", "tbd.jiggytom.com/"]]);
      $("agentMatrixCore").innerHTML =
        row("ok", "Executor", "12ms") + row("ok", "API key", "verified") + row("ok", "Agent tabs", "1");
    },
  },
};

function selectView(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach((p) => {
    const on = p.dataset.panel === name;
    p.classList.toggle("active", on);
    p.hidden = !on;
  });
}

document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => selectView(t.dataset.tab));
});
document.querySelectorAll("[data-goto]").forEach((el) => {
  el.addEventListener("click", () => selectView(el.dataset.goto));
});

document.querySelectorAll(".state-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".state-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const s = STATES[btn.dataset.state];
    device.dataset.state = btn.dataset.state;
    s.apply();
    selectView(s.view);
  });
});

// deep-linkable states: index.html#needs-key etc.
const initial = location.hash.replace("#", "");
const boot = STATES[initial] ? initial : "connected";
document.querySelectorAll(".state-btn").forEach((b) => {
  b.classList.toggle("active", b.dataset.state === boot);
});
device.dataset.state = boot;
STATES[boot].apply();
selectView(STATES[boot].view);

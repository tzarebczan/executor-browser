import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attributionFrom,
  browserActivityEntry,
  displayActor,
  modernizeActivity,
} from "../extension/lib/activity.js";

test("rewrites the transport's old name out of history already written", () => {
  // Renaming the strings in source only changed what gets written next. These
  // entries were persisted before the rename and kept appearing in the feed
  // long after it, which reads as the fix not having shipped.
  const { entries, changed } = modernizeActivity([
    { id: "a", message: "Reverse bridge session bbs_msfp4k2" },
    { id: "b", message: "Reverse channel unavailable: server endpoint missing" },
    { id: "c", message: "Reverse session open failed; retrying on keepalive" },
    { id: "d", summary: "Checked browser connection", detail: "Extension reverse bridge" },
  ]);

  assert.equal(changed, true);
  assert.deepEqual(
    entries.map((entry) => entry.message ?? entry.detail),
    [
      "Agent control connected",
      "Agent control unavailable on this Executor",
      "Could not open agent control; retrying shortly",
      "Agent control channel",
    ],
  );
  // The session id went with it: it named the mechanism and helped nobody.
  assert.doesNotMatch(JSON.stringify(entries), /bbs_|reverse|bridge/i);
});

test("leaves current entries untouched, and says so by identity", () => {
  // `changed` drives whether storage is rewritten. Reporting a change every
  // read would write the whole log back on every panel open.
  const current = [
    { id: "a", message: "Agent control connected" },
    { id: "b", summary: "Listed controlled tabs", detail: "1 tab" },
  ];
  const result = modernizeActivity(current);

  assert.equal(result.changed, false);
  assert.equal(result.entries, current);
});

test("keeps the client's claim about itself apart from the authenticated principal", () => {
  // Any client can call itself anything; only `principal` is server-derived.
  const spoofed = attributionFrom({ name: "claude-code", principal: "user_9f2" });
  assert.equal(spoofed.actor, "Claude");
  assert.equal(spoofed.actorClaimed, true);
  assert.equal(spoofed.principal, "user_9f2");

  const anonymous = attributionFrom({ name: "unknown", principal: "user_9f2" });
  assert.equal(anonymous.actor, "Agent via Executor");
  assert.equal(anonymous.principal, "user_9f2");
});

test("never reports an agent name as verified, even when one is supplied", () => {
  const entry = browserActivityEntry(
    { id: "job-9", tool: "ping", args: {}, caller: { name: "Executor", principal: "user_1" } },
    { ok: true },
    0,
    5,
  );
  assert.equal(entry.actorClaimed, true);
  assert.equal(entry.principal, "user_1");
});

test("normalizes common MCP client names", () => {
  assert.equal(displayActor({ name: "codex-mcp", version: "1" }), "Codex");
  assert.equal(displayActor({ name: "claude-code" }), "Claude");
  assert.equal(displayActor({ name: "grok-agent" }), "Grok");
  assert.equal(displayActor(null), "Agent via Executor");
});

test("records useful snapshot attribution and target details", () => {
  const entry = browserActivityEntry(
    {
      id: "job-1",
      tool: "snapshot",
      args: { tabId: 7 },
      caller: { name: "codex", version: "2.0" },
    },
    {
      ok: true,
      tab: { id: 7, title: "Example", url: "https://example.test/page" },
      snapshot: { nodes: [{}, {}] },
    },
    100,
    145,
  );

  assert.equal(entry.actor, "Codex");
  assert.equal(entry.summary, "Inspected page structure");
  assert.equal(entry.detail, "2 accessible nodes");
  assert.equal(entry.target.title, "Example");
  assert.equal(entry.durationMs, 45);
  assert.equal(entry.outcome, "ok");
});

test("does not retain typed text", () => {
  const secret = "do-not-store-this-secret";
  const entry = browserActivityEntry(
    {
      id: "job-2",
      tool: "type",
      args: { tabId: 7, selector: "#query", text: secret, submit: true },
      caller: { name: "claude-code" },
    },
    { ok: true, tabId: 7 },
    200,
    400,
  );

  assert.equal(entry.actor, "Claude");
  assert.equal(entry.summary, "Typed into a page and submitted");
  assert.doesNotMatch(JSON.stringify(entry), new RegExp(secret));
});

test("does not retain screenshot image data", () => {
  const entry = browserActivityEntry(
    { id: "job-3", tool: "screenshot", args: {}, caller: { name: "grok" } },
    { ok: true, dataUrl: "data:image/jpeg;base64,private-image" },
    300,
    500,
  );

  assert.equal(entry.actor, "Grok");
  assert.doesNotMatch(JSON.stringify(entry), /private-image/);
});

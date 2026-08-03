import assert from "node:assert/strict";
import { test } from "node:test";

import { browserActivityEntry, displayActor } from "../extension/lib/activity.js";

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

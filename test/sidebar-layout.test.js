import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("the panel is one screen: status, address, key, developer tools", async () => {
  const html = await readFile(new URL("extension/sidebar.html", root), "utf8");

  assert.match(html, /id="glance"/);
  assert.match(html, /id="executorUrl"/);
  assert.match(html, /id="executorApiKey"/);
  assert.match(html, /name="cdpMode" value="always"/);
  assert.doesNotMatch(html, /role="tablist"/);
  assert.doesNotMatch(html, /id="previewImg"/);
  assert.doesNotMatch(html, /id="tabList"/);
  assert.doesNotMatch(html, /Local preview/);
});

test("status is large enough to read and coloured by state", async () => {
  const css = await readFile(new URL("extension/sidebar.css", root), "utf8");
  const glance = css.match(/\.glance\s*\{[\s\S]*?\}/)?.[0] || "";
  const size = Number(glance.match(/font-size:\s*([\d.]+)px/)?.[1]);
  assert.ok(size >= 16, `glance font-size is ${size}px`);
  assert.match(css, /\.glance\[data-state="connected"\][\s\S]*var\(--live\)/);
  assert.match(css, /\.glance\[data-state="offline"\][\s\S]*var\(--fault\)/);

  const channel = (hex, at) => parseInt(hex.slice(at, at + 2), 16);
  const declared = (name) => css.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1] || "";
  const fault = declared("--fault");
  const live = declared("--live");
  assert.ok(channel(fault, 1) > channel(fault, 3), `--fault ${fault} is not red-dominant`);
  assert.ok(channel(live, 3) > channel(live, 1), `--live ${live} is not green-dominant`);
});

test("nothing user-facing talks about a bridge or a reverse channel", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("extension/sidebar.html", root), "utf8"),
    readFile(new URL("extension/sidebar.js", root), "utf8"),
  ]);

  assert.doesNotMatch(html, /reverse/i);
  assert.doesNotMatch(html, /\bbridge\b/i);

  const PROTOCOL_LITERALS = new Set(['"reverse"', '"startReverseBridge"', '"bridge-missing"']);
  const leaks = [];
  for (const line of script.split("\n")) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    const literals = (line.match(/"[^"\n]*"/g) || []).filter((_, index) => index % 2 === 0);
    for (const literal of literals) {
      if (/reverse|bridge/i.test(literal) && !PROTOCOL_LITERALS.has(literal)) leaks.push(literal);
    }
  }
  assert.deepEqual(leaks, []);
});

test("activity entries do not name the mechanism either", async () => {
  const sources = ["extension/lib/reverse-bridge.js", "extension/lib/activity.js"];
  const leaks = [];
  for (const source of sources) {
    const text = await readFile(new URL(source, root), "utf8");
    for (const [, message] of text.matchAll(/message:\s*(["`])([^"`]*)\1/g)) {
      if (/reverse|bridge/i.test(message)) leaks.push(`${source}: ${message}`);
    }
    for (const [, summary] of text.matchAll(/(?:summary|detail):\s*"([^"]*)"/g)) {
      if (/reverse|bridge/i.test(summary)) leaks.push(`${source}: ${summary}`);
    }
  }
  assert.deepEqual(leaks, []);
});

test("developer tools save the always-on setting with the other access knobs", async () => {
  const [html, script, background] = await Promise.all([
    readFile(new URL("extension/sidebar.html", root), "utf8"),
    readFile(new URL("extension/sidebar.js", root), "utf8"),
    readFile(new URL("extension/background.js", root), "utf8"),
  ]);
  assert.match(html, /value="always"/);
  assert.match(script, /cdpMode: input\.value/);
  assert.match(background, /"cdpMode"/);
});

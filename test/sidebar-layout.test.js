import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Home sections are independently collapsible", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("extension/sidebar.html", root), "utf8"),
    readFile(new URL("extension/sidebar.js", root), "utf8"),
  ]);

  assert.match(html, /data-collapsible-section="status"/);
  assert.match(html, /data-collapsible-section="preview" data-default-collapsed="true"/);
  assert.match(html, /data-collapsible-section="activity"/);
  assert.equal((html.match(/data-collapse-toggle/g) || []).length, 3);
  assert.match(script, /COLLAPSE_STATE_KEY/);
  assert.match(script, /localStorage\.setItem\(COLLAPSE_STATE_KEY/);
  assert.match(script, /setAttribute\("aria-expanded"/);
});

test("Uplink, Bridge, and Tabs use the compact horizontal status grid", async () => {
  const [html, css] = await Promise.all([
    readFile(new URL("extension/sidebar.html", root), "utf8"),
    readFile(new URL("extension/sidebar.css", root), "utf8"),
  ]);

  const strip = html.match(/<div class="spine"[\s\S]*?<\/div>\s*<\/div>\s*<\/section>/)?.[0] || "";
  assert.match(strip, />Uplink</);
  assert.match(strip, />Bridge</);
  assert.match(strip, />Tabs</);
  assert.match(css, /\.spine\s*\{[\s\S]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.sig-d\s*\{\s*display:\s*none/);
});

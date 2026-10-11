import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const html = await readFile(new URL("../extension/sidebar.html", import.meta.url), "utf8");

test("status is announced, and the address and key are labelled", () => {
  assert.match(html, /id="glance"[^>]*role="status"/);
  assert.match(html, /<label class="field">\s*<span>Executor<\/span>[\s\S]*id="executorUrl"/);
  assert.match(html, /<label class="field">\s*<span>API key<\/span>[\s\S]*id="executorApiKey"/);
});

test("developer tools are a named radio group", () => {
  assert.match(html, /role="radiogroup" aria-label="Developer tools"/);
  for (const value of ["off", "session", "always"]) {
    assert.match(html, new RegExp(`name="cdpMode" value="${value}"`));
  }
});

test("the panel is not a tab set", () => {
  assert.doesNotMatch(html, /role="tab"/);
  assert.doesNotMatch(html, /role="tablist"/);
  assert.doesNotMatch(html, /role="tabpanel"/);
});

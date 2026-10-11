import assert from "node:assert/strict";
import { test } from "node:test";

const {
  detectBrowser,
  localToolAddress,
  preferredConnectionName,
} = await import("../extension/lib/browser-identity.js");

test("detects Chromium products from UA", () => {
  assert.equal(detectBrowser("Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36", false), "Chrome");
  assert.equal(detectBrowser("Mozilla/5.0 Chrome/120.0.0.0 Edg/120.0.0.0", false), "Edge");
  assert.equal(detectBrowser("Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36", true), "Brave");
});

test("Chrome without a label stays desktop so existing agents keep working", () => {
  assert.equal(preferredConnectionName("Chrome"), "desktop");
  assert.equal(preferredConnectionName("Chromium"), "desktop");
  assert.equal(preferredConnectionName("Brave"), "brave");
  assert.equal(preferredConnectionName("Edge"), "edge");
});

test("a user label and a previously assigned name win", () => {
  assert.equal(preferredConnectionName("Chrome", "Work"), "work");
  assert.equal(preferredConnectionName("Brave", "", "labBrave"), "labBrave");
});

test("tool address is the execute path agents call", () => {
  assert.equal(localToolAddress("desktop"), "tools.browser.user.desktop");
  assert.equal(localToolAddress("brave"), "tools.browser.user.brave");
});

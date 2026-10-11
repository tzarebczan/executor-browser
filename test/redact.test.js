import assert from "node:assert/strict";
import { test } from "node:test";

const { redactText, redactUrl } = await import("../extension/lib/redact.js");

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.Sf-KxwRJSM";

test("strips credential-shaped substrings from captured text", () => {
  assert.equal(
    redactText("Authorization: Bearer sk-abc123.def"),
    "Authorization: Bearer [redacted]",
  );
  assert.equal(redactText("GET /cb?code=xyz123&state=ok"), "GET /cb?code=[redacted]&state=ok");
  // A JWT standing on its own is recognised by shape, with no keyword to go on.
  assert.match(redactText(`decoded ${JWT} ok`), /\[redacted-jwt\]/);
});

test("covers authorization schemes beyond Bearer", () => {
  // Basic carries base64 user:password, which is a credential in plain sight.
  assert.equal(redactText("Authorization: Basic dXNlcjpwYXNz"), "Authorization: Basic [redacted]");
  assert.equal(redactText("Authorization: Token abc123"), "Authorization: Token [redacted]");
});

test("redacts credential assignments wherever they appear, not only in a query string", () => {
  for (const line of [
    "config api_key=sk_live_secret loaded",
    'body {"client_secret": "shhh"}',
    "env PASSWORD:hunter2",
    `header id_token=${JWT}`,
  ]) {
    const out = redactText(line);
    assert.doesNotMatch(out, /sk_live_secret|shhh|hunter2/, line);
    assert.doesNotMatch(out, new RegExp(JWT.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")), line);
  }
});

test("strips credentials carried in URL userinfo", () => {
  assert.equal(
    redactUrl("https://admin:hunter2@internal.test/status?x=1"),
    "https://internal.test/status",
  );
  assert.doesNotMatch(redactText("fetching https://admin:hunter2@internal.test/"), /hunter2/);
});

test("keeps ordinary console output intact", () => {
  assert.equal(redactText("render complete in 42ms"), "render complete in 42ms");
});

test("caps captured text length", () => {
  assert.equal(redactText("x".repeat(5000)).length, 2000);
  assert.equal(redactText("x".repeat(5000), 500).length, 500);
});

test("reduces request URLs to origin and path", () => {
  assert.equal(
    redactUrl("https://api.test/v1/items?api_key=secret#frag"),
    "https://api.test/v1/items",
  );
  assert.equal(redactUrl("not a url?token=secret"), "not a url");
});

test("never returns a query string, whatever the parameter is named", () => {
  // An allowlist of known-sensitive names would leak the ones we did not predict.
  const out = redactUrl("https://api.test/x?unexpected_credential=abc&b=2");
  assert.equal(out.includes("abc"), false);
  assert.equal(out.includes("?"), false);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("does not expose browser control to web pages", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url)));
  const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");

  assert.equal(manifest.externally_connectable, undefined);
  assert.doesNotMatch(background, /onMessageExternal/);
  assert.doesNotMatch(background, /pairFromWeb/);
});

test("uses one owned-tab source for both UI status and remote tools", async () => {
  const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");

  assert.match(background, /import\s*\{[^}]*listAgentTabs[^}]*\}\s*from "\.\/lib\/browser-tools\.js"/s);
  assert.doesNotMatch(background, /async function listAgentTabs/);
  assert.doesNotMatch(background, /chrome\.windows\.getAll/);
});

test("does not truncate reverse-bridge screenshot results", async () => {
  const reverseBridge = await readFile(
    new URL("../extension/lib/reverse-bridge.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(reverseBridge, /delete payload\._fullDataUrl/);
  assert.doesNotMatch(reverseBridge, /payload\.dataUrl\s*=/);
});

test("reports the shipped version, never a hand-written copy of it", async () => {
  // A literal drifts: the MCP handshake and the reverse session had already
  // disagreed about which version was running. The manifest is the one source.
  for (const file of ["../extension/lib/reverse-bridge.js", "../extension/background.js"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /version: ["']\d+\.\d+\.\d+["']/, file);
  }
  const reverseBridge = await readFile(
    new URL("../extension/lib/reverse-bridge.js", import.meta.url),
    "utf8",
  );
  assert.match(reverseBridge, /chrome\.runtime\.getManifest\(\)\.version/);

  // The panel was the file this rule did not cover, so of course it is where a
  // literal survived, and it had already fallen a patch release behind the
  // manifest by the time anyone looked.
  const [html, sidebar] = await Promise.all([
    readFile(new URL("../extension/sidebar.html", import.meta.url), "utf8"),
    readFile(new URL("../extension/sidebar.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(html, /v\d+\.\d+\.\d+/);
  assert.match(sidebar, /versionLabel[\s\S]{0,200}getManifest\(\)\.version/);
});

test("browser use history supports individual removal and active indicators", async () => {
  const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  const reverseBridge = await readFile(
    new URL("../extension/lib/reverse-bridge.js", import.meta.url),
    "utf8",
  );

  assert.match(background, /case "removeActivity"/);
  // The user must be able to tell, without opening the panel, that an agent is
  // driving their browser right now. This used to be a "USE" badge painted over
  // the icon; it is a distinct icon state now, but the guarantee is the same.
  assert.match(background, /paintIcon\("active"\)/);
  assert.match(background, /\[ACTIVE\]/);
  assert.match(reverseBridge, /browserActivityEntry\(job, result, startedAt\)/);
  assert.match(reverseBridge, /generation !== runGeneration/);
  assert.match(reverseBridge, /resultSessionId/);
});

test("reverse sessions advertise the active access scope", async () => {
  const reverseBridge = await readFile(
    new URL("../extension/lib/reverse-bridge.js", import.meta.url),
    "utf8",
  );
  assert.match(reverseBridge, /accessAdvertisement\(\)/);
  assert.match(reverseBridge, /capabilities:\s*\{[^}]*BROWSER_TOOLS_META[^}]*access/s);
});

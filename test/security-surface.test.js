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

test("manifest version matches reverse-bridge client version", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url)));
  const reverseBridge = await readFile(
    new URL("../extension/lib/reverse-bridge.js", import.meta.url),
    "utf8",
  );
  assert.match(reverseBridge, new RegExp(`version: "${manifest.version}"`));
});

test("browser use history supports individual removal and active indicators", async () => {
  const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  const reverseBridge = await readFile(
    new URL("../extension/lib/reverse-bridge.js", import.meta.url),
    "utf8",
  );

  assert.match(background, /case "removeActivity"/);
  assert.match(background, /setBadgeText\(\{ text: "USE" \}\)/);
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

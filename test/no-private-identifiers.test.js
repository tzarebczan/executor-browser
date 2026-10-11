import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * This extension is published. Personal infrastructure, a private tailnet
 * hostname, a personal domain used as a default landing page, must never ship
 * in it, so the check runs over the tree rather than over a list of known files.
 */
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude"]);
const CHECKED = new Set([".js", ".html", ".css", ".json", ".md"]);

const FORBIDDEN = [
  { pattern: /jiggytom/i, why: "personal domain" },
  { pattern: /taile\d{6,}\.ts\.net/i, why: "private tailnet MagicDNS name" },
  { pattern: /lab-agents/i, why: "private host name" },
];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (CHECKED.has(extname(entry.name))) {
      yield join(dir, entry.name);
    }
  }
}

test("ships no private hostnames or personal domains", async () => {
  const offenders = [];
  for await (const file of walk(ROOT)) {
    if (file === SELF) continue; // this file necessarily spells the patterns out
    const text = await readFile(file, "utf8");
    for (const { pattern, why } of FORBIDDEN) {
      if (pattern.test(text)) {
        offenders.push(`${file.slice(ROOT.length)} contains a ${why} (${pattern})`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

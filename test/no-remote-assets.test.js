import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * The panel must render without reaching the network.
 *
 * A side panel that requests a CDN font on every open leaks usage to a third
 * party and renders unstyled offline, neither is acceptable in a shipped
 * extension. The typeface is vendored instead, so this guards the whole class
 * rather than the one CDN we happened to remove.
 */
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", "fonts"]);
const CHECKED = new Set([".html", ".css"]);

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

test("no markup or stylesheet pulls an asset over the network", async () => {
  const offenders = [];
  for await (const file of walk(ROOT)) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/(?:href|src)\s*=\s*["']https?:\/\/[^"']+["']/gi)) {
      offenders.push(`${file.slice(ROOT.length)}: ${match[0]}`);
    }
    for (const match of text.matchAll(/url\(\s*["']?https?:\/\/[^)"']+/gi)) {
      offenders.push(`${file.slice(ROOT.length)}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the branded typeface is present as bytes, not a promise of one", async () => {
  const css = await readFile(new URL("../extension/sidebar.css", import.meta.url), "utf8");
  assert.match(css, /@font-face/);
  for (const font of ["geist-sans.woff2", "geist-mono.woff2"]) {
    assert.match(css, new RegExp(font.replace(".", "\\.")), `sidebar.css references ${font}`);
    await access(new URL(`../extension/fonts/${font}`, import.meta.url));
  }
});

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

const STATES = ["off", "error", "live", "active"];

/** Minimal PNG header read: width, height, and colour type. */
async function png(path) {
  const bytes = await readFile(new URL(path, root));
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG", `${path} is a PNG`);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colourType: bytes.readUInt8(25),
  };
}

test("every status the service worker paints has an icon on disk", async () => {
  // setIcon fails silently-ish on a missing path: Chrome keeps the previous
  // icon, so a typo here would look like a status that never updates.
  const background = await readFile(new URL("extension/background.js", root), "utf8");
  const painted = [...background.matchAll(/paintIcon\("(\w+)"\)/g)].map((m) => m[1]);
  const referenced = new Set([...painted, ...STATES]);

  for (const state of referenced) {
    for (const size of [16, 48]) {
      await access(new URL(`extension/icons/icon${size}-${state}.png`, root));
    }
  }
  // And the reverse: nothing painted that the design does not define.
  for (const state of painted) assert.ok(STATES.includes(state), `unknown icon state ${state}`);
});

test("icons are the size they claim, with an alpha channel", async () => {
  // A disc with no alpha renders as a black square on a light toolbar.
  for (const size of [16, 48, 128]) {
    const meta = await png(`extension/icons/icon${size}.png`);
    assert.equal(meta.width, size);
    assert.equal(meta.height, size);
    assert.equal(meta.colourType, 6, `icon${size}.png is RGBA`);
  }
  for (const state of STATES) {
    for (const size of [16, 48]) {
      const meta = await png(`extension/icons/icon${size}-${state}.png`);
      assert.equal(meta.width, size);
      assert.equal(meta.colourType, 6);
    }
  }
});

test("status never covers the mark with badge text", async () => {
  // Chrome draws badge text as a rounded rectangle across the bottom of the
  // icon. At 16px that is most of the icon, so the logo disappeared exactly
  // when the extension had something to say. Status is a dot on the mark now.
  const background = await readFile(new URL("extension/background.js", root), "utf8");
  const badgeWrites = [...background.matchAll(/setBadgeText\(\{\s*text:\s*([^}]+?)\s*\}/g)];
  assert.ok(badgeWrites.length > 0, "badge text is still explicitly cleared");
  for (const [, value] of badgeWrites) {
    assert.equal(value, '""', "badge text must only ever be cleared");
  }
  assert.doesNotMatch(background, /setBadgeBackgroundColor/);
});

test("the mark is the product's, not a look-alike", async () => {
  // The old icon was a blue circle around a green rectangle in Chrome's own
  // palette, it shared no identity with Executor. The generator composites the
  // published favicon rather than redrawing it, so this checks the source is
  // present and that nothing reintroduced the old palette.
  await access(new URL("design/source/executor-mark.png", root));
  const generator = await readFile(new URL("design/make-icons.py", root), "utf8");
  assert.match(generator, /favicon-192\.png/);
  for (const googleColour of ["8ab4f8", "34a853", "ea4335"]) {
    assert.doesNotMatch(generator, new RegExp(googleColour, "i"));
  }
});

// UI tests. They drive the real page in a real browser, with lib/client.js swapped for
// tests/stub-client.js so no model is needed. Run: node tests/ui.test.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(here, "out");
fs.mkdirSync(out, { recursive: true });
const stub = fs.readFileSync(path.join(here, "stub-client.js"), "utf8");

const server = await serve(root);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });

/** Open the page with the stub in place. `init` runs in the page before any script. */
async function open({ query = "", viewport = { width: 1100, height: 900 }, init } = {}) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()}`));
  await page.route("**/lib/client.js", (route) => route.fulfill({ contentType: "text/javascript", body: stub }));
  if (init) await page.addInitScript(init);
  await page.goto(server.url + query);
  await page.waitForFunction(() => globalThis.__harmony);
  return { page, context, problems };
}

const status = (page) => page.locator("#status").innerText();
const waitStatus = (page, text) =>
  page.waitForFunction((t) => document.querySelector("#status").textContent.includes(t), text, { timeout: 15_000 });

/** How many of each tile's 256 pixels are painted, and a fingerprint of each tile. */
const readTiles = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".tile canvas")].map((c) => {
      const d = c.getContext("2d").getImageData(0, 0, 16, 16).data;
      let painted = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
      return { painted, print: Array.from(d).join(",") };
    }),
  );

async function makeOne(page, prompt) {
  await page.fill("#prompt", prompt);
  await page.click("#make");
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("opens clean: title, four empty tiles, nothing downloaded yet", async () => {
  const { page, problems } = await open();
  assert.equal(await page.title(), "Harmony emoji maker");
  assert.equal(await page.locator("h1").innerText(), "Harmony emoji maker");
  assert.equal(await page.locator(".tile").count(), 4);
  assert.equal(await page.locator("#make").innerText(), "Make 4");
  assert.equal(await page.locator("#actions").isHidden(), true);
  assert.equal(await page.locator("#progress").isHidden(), true);
  assert.equal(await page.evaluate(() => globalThis.__stub), undefined, "the model must not load before the person asks");
  for (const t of await readTiles(page)) assert.equal(t.painted, 0);
  assert.deepEqual(problems, []);
});

test("an empty prompt asks for one and does not load the model", async () => {
  const { page } = await open();
  await page.fill("#prompt", "   ");
  await page.click("#make");
  assert.match(await status(page), /Type what the emoji should be/);
  assert.equal(await page.locator("#status").getAttribute("data-kind"), "error");
  assert.equal(await page.evaluate(() => globalThis.__stub), undefined);
  assert.equal(await page.evaluate(() => document.activeElement.id), "prompt");
});

test("typing a prompt paints four different emoji, with loading progress on the way", async () => {
  const { page, problems } = await open();
  // Record every status line and the widest the progress bar gets.
  await page.evaluate(() => {
    globalThis.__seen = { status: [], bar: 0, barShown: false };
    new MutationObserver(() => {
      __seen.status.push(document.querySelector("#status").textContent);
      __seen.bar = Math.max(__seen.bar, Number(document.querySelector(".bar").getAttribute("aria-valuenow")));
      if (!document.querySelector("#progress").hidden) __seen.barShown = true;
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await makeOne(page, "  a   happy frog ");
  await waitStatus(page, "Tap the one you like.");

  const seen = await page.evaluate(() => globalThis.__seen);
  assert.ok(seen.barShown, "progress bar was shown while loading");
  assert.equal(seen.bar, 100);
  assert.ok(seen.status.some((s) => /Downloading the model: \d+ of 115 MB/.test(s)), "download progress in MB");
  assert.ok(seen.status.includes("Loading the model into memory"));
  assert.ok(seen.status.includes("Checking your graphics card"));
  assert.ok(seen.status.includes("Painting, step 1 of 16"));
  assert.ok(seen.status.includes("Painting, step 16 of 16"));
  assert.equal(await page.locator("#progress").isHidden(), true, "progress bar hides once loaded");

  const calls = await page.evaluate(() => globalThis.__stub.generates);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, "a happy frog", "prompt is trimmed and single-spaced");
  assert.equal(calls[0].n, 4);
  assert.ok(Number.isInteger(calls[0].seed) && calls[0].seed >= 0 && calls[0].seed <= 0xffffffff);

  const t = await readTiles(page);
  assert.equal(t.length, 4);
  for (const tile of t) assert.ok(tile.painted > 100 && tile.painted < 256, `painted ${tile.painted} px`);
  assert.equal(new Set(t.map((x) => x.print)).size, 4, "the four emoji differ");

  assert.equal(await page.locator("#actions").isVisible(), true);
  assert.equal(await page.locator("#download").isDisabled(), true, "nothing picked yet");
  assert.match(await page.locator("#device").innerText(), /graphics card/);
  assert.equal(await page.locator("#make").isEnabled(), true);
  assert.deepEqual(problems, []);
  await page.screenshot({ path: path.join(out, "desktop-results.png"), fullPage: true });
});

test("picking a tile and downloading gives a 128 px PNG that matches it pixel for pixel", async () => {
  const { page } = await open();
  await makeOne(page, "A Sleepy Cat!! (v2)");
  await waitStatus(page, "Tap the one you like.");
  await page.locator(".tile").nth(2).click();
  assert.deepEqual(
    await page.locator(".tile").evaluateAll((els) => els.map((e) => e.getAttribute("aria-pressed"))),
    ["false", "false", "true", "false"],
  );
  assert.equal(await page.locator("#download").isEnabled(), true);

  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
  assert.equal(download.suggestedFilename(), "a-sleepy-cat-v2.png");
  const file = path.join(out, "downloaded.png");
  await download.saveAs(file);
  const bytes = fs.readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
  assert.equal(bytes.readUInt32BE(16), 128, "width");
  assert.equal(bytes.readUInt32BE(20), 128, "height");
  assert.equal(bytes[25], 6, "colour type 6: RGB with alpha");
  assert.ok(bytes.length < 128 * 1024, "under Slack's 128 KB limit");

  // Decode the file in the browser and compare each pixel with the tile, scaled 8x.
  const cmp = await page.evaluate(async (b64) => {
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([raw], { type: "image/png" }));
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const got = ctx.getImageData(0, 0, 128, 128).data;
    const src = document.querySelectorAll(".tile canvas")[2].getContext("2d").getImageData(0, 0, 16, 16).data;
    let wrong = 0;
    let clear = 0;
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) {
        const g = (y * 128 + x) * 4;
        const s = ((y >> 3) * 16 + (x >> 3)) * 4;
        if (src[s + 3] === 0) {
          clear++;
          if (got[g + 3] !== 0) wrong++;
        } else if (got[g] !== src[s] || got[g + 1] !== src[s + 1] || got[g + 2] !== src[s + 2] || got[g + 3] !== 255) wrong++;
      }
    return { wrong, clear };
  }, bytes.toString("base64"));
  assert.equal(cmp.wrong, 0, "every pixel matches");
  assert.ok(cmp.clear > 0 && cmp.clear % 64 === 0, "see-through pixels stay see-through, in whole 8x8 squares");
  assert.equal(await status(page), "Downloaded a-sleepy-cat-v2.png");
});

test("making again gives new emoji, clears the pick, and does not reload the model", async () => {
  const { page } = await open();
  await makeOne(page, "a rocket");
  await waitStatus(page, "Tap the one you like.");
  const first = await readTiles(page);
  await page.locator(".tile").nth(0).click();
  await page.click("#make");
  await waitStatus(page, "Tap the one you like.");
  const second = await readTiles(page);
  assert.notDeepEqual(first.map((t) => t.print), second.map((t) => t.print));
  const s = await page.evaluate(() => globalThis.__stub);
  assert.equal(s.loads, 1, "model loaded once");
  assert.equal(s.generates.length, 2);
  assert.notEqual(s.generates[0].seed, s.generates[1].seed);
  assert.equal(await page.locator('.tile[aria-pressed="true"]').count(), 0);
  assert.equal(await page.locator("#download").isDisabled(), true);
});

test("pressing Enter in the box works like the button", async () => {
  const { page } = await open();
  await page.fill("#prompt", "a red heart");
  await page.press("#prompt", "Enter");
  await waitStatus(page, "Tap the one you like.");
  assert.equal((await page.evaluate(() => globalThis.__stub.generates)).length, 1);
});

test("an idea chip fills the box but does not start a download", async () => {
  const { page } = await open();
  await page.click('[data-idea="a slice of pizza"]');
  assert.equal(await page.inputValue("#prompt"), "a slice of pizza");
  assert.equal(await page.evaluate(() => globalThis.__stub), undefined);
});

test("while it is working, the button is off and a second request is ignored", async () => {
  const { page } = await open();
  await makeOne(page, "a rocket");
  assert.equal(await page.locator("#make").isDisabled(), true);
  await page.evaluate(() => document.querySelector("#ask").requestSubmit());
  await waitStatus(page, "Tap the one you like.");
  assert.equal((await page.evaluate(() => globalThis.__stub.generates)).length, 1);
});

test("a failed model download says why and can be retried", async () => {
  const { page } = await open({ init: () => (globalThis.__stubLoadFailures = 1) });
  await makeOne(page, "a rocket");
  await waitStatus(page, "That didn't work");
  assert.match(await status(page), /Couldn't download models\/tessera_w8\.onnx \(HTTP 404\)/);
  assert.equal(await page.locator("#status").getAttribute("data-kind"), "error");
  assert.equal(await page.locator("#progress").isHidden(), true);
  assert.equal(await page.locator("#actions").isHidden(), true);
  assert.equal(await page.locator("#make").isEnabled(), true);
  await page.click("#make");
  await waitStatus(page, "Tap the one you like.");
  assert.equal(await page.evaluate(() => globalThis.__stub.loads), 2);
});

test("a failed painting says why, clears the tiles, and the next try works", async () => {
  const { page } = await open();
  await makeOne(page, "a rocket");
  await waitStatus(page, "Tap the one you like.");
  await makeOne(page, "please explode");
  await waitStatus(page, "That didn't work");
  assert.match(await status(page), /the stub was asked to fail/);
  for (const t of await readTiles(page)) assert.equal(t.painted, 0, "no stale emoji left on screen");
  assert.equal(await page.locator("#actions").isHidden(), true);
  assert.equal(await page.locator(".tile").first().isDisabled(), true);
  await makeOne(page, "a rocket");
  await waitStatus(page, "Tap the one you like.");
  assert.equal(await page.locator(".tile").first().isEnabled(), true);
});

test("without WebGPU it says it is painting on the processor", async () => {
  const { page } = await open({ init: () => (globalThis.__stubDevice = "cpu") });
  await makeOne(page, "a rocket");
  await waitStatus(page, "Tap the one you like.");
  assert.match(await page.locator("#device").innerText(), /no WebGPU.*processor.*slower/);
});

test("it warns when the last visit ran out of memory", async () => {
  const { page } = await open({ init: () => localStorage.setItem("slack-moji:loading", "1") });
  assert.match(await status(page), /ran out of memory/);
});

test("?n=1 makes a single emoji and picks it for you", async () => {
  const { page } = await open({ query: "?n=1" });
  assert.equal(await page.locator(".tile").count(), 1);
  assert.equal(await page.locator("#make").innerText(), "Make 1");
  await makeOne(page, "a rocket");
  await waitStatus(page, "Painted.");
  assert.equal((await page.evaluate(() => globalThis.__stub.generates))[0].n, 1);
  assert.equal(await page.locator("#download").isEnabled(), true);
});

test("odd ?n values fall back to a sane count", async () => {
  for (const [q, n] of [["?n=0", 4], ["?n=99", 4], ["?n=abc", 4], ["?n=-3", 1], ["?n=2", 2]]) {
    const { page, context } = await open({ query: q });
    assert.equal(await page.locator(".tile").count(), n, q);
    await context.close();
  }
});

test("on a phone-sized screen nothing overflows and the tiles sit two by two", async () => {
  const { page, problems } = await open({ viewport: { width: 380, height: 800 } });
  await makeOne(page, "a happy frog");
  await waitStatus(page, "Tap the one you like.");
  await page.locator(".tile").nth(1).click();
  const m = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: innerWidth,
    tops: [...document.querySelectorAll(".tile")].map((t) => Math.round(t.getBoundingClientRect().top)),
    input: document.querySelector("#prompt").getBoundingClientRect().width,
    button: document.querySelector("#make").getBoundingClientRect().height,
  }));
  assert.ok(m.scroll <= m.inner, `no sideways scroll (${m.scroll} > ${m.inner})`);
  assert.equal(new Set(m.tops).size, 2, "two rows of tiles");
  assert.ok(m.input >= 180, "the text box stays usable");
  assert.ok(m.button >= 44, "the button is big enough to tap");
  assert.deepEqual(problems, []);
  await page.screenshot({ path: path.join(out, "phone-results.png"), fullPage: true });
});

test("the keyboard alone can pick and download", async () => {
  const { page } = await open();
  await makeOne(page, "a rocket");
  await waitStatus(page, "Tap the one you like.");
  await page.locator(".tile").nth(3).focus();
  await page.keyboard.press("Space");
  assert.equal(await page.locator(".tile").nth(3).getAttribute("aria-pressed"), "true");
  await page.locator("#download").focus();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
  assert.equal(download.suggestedFilename(), "a-rocket.png");
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(err?.stack ?? err).split("\n").join("\n      ")}`);
  }
  for (const c of browser.contexts()) await c.close();
}
await browser.close();
await server.close();
console.log(`\n${tests.length - failed} of ${tests.length} passed`);
process.exit(failed ? 1 : 0);

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
  if (!query.startsWith("sheet.html")) await page.waitForFunction(() => globalThis.__harmony);
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

/** Fingerprint of any 16 x 16 canvas on the page. */
const printOf = (page, selector) =>
  page.evaluate((sel) => Array.from(document.querySelector(sel).getContext("2d").getImageData(0, 0, 16, 16).data).join(","), selector);

const pressed = (page) => page.locator(".tile").evaluateAll((els) => els.map((e) => e.getAttribute("aria-pressed")));

async function makeOne(page, prompt) {
  await page.fill("#prompt", prompt);
  await page.click("#make");
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("opens clean: title, no results yet, nothing downloaded yet", async () => {
  const { page, problems } = await open();
  assert.equal(await page.title(), "Harmony emoji maker");
  assert.equal(await page.locator("h1").innerText(), "Harmony emoji maker");
  assert.equal(await page.locator(".tile").count(), 4);
  assert.equal(await page.locator("#make").innerText(), "Make 4");
  assert.equal(await page.locator("#results").isHidden(), true, "no empty result boxes before the first emoji");
  assert.equal(await page.locator("#progress").isHidden(), true);
  assert.equal(await page.locator("#status").isHidden(), true, "no empty status line");
  assert.equal(await page.evaluate(() => globalThis.__stub), undefined, "the model must not load before the person asks");
  for (const t of await readTiles(page)) assert.equal(t.painted, 0);
  // The page credits the model; the full credits are one link away.
  const credits = await page.locator(".credits").innerText();
  assert.match(credits, /Tessera-small by Jagrat Patel/);
  assert.doesNotMatch(credits, /Caleb|Slack Moji/i);
  assert.equal(
    await page.locator('.credits a:has-text("Credits and license")').getAttribute("href"),
    "https://github.com/harmonyso/harmony-emoji-maker#credits-and-license",
  );
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
  await waitStatus(page, "Painted. Tap another one to switch.");

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

  assert.equal(await page.locator("#results").isVisible(), true);
  assert.equal(await page.locator("#actions").isVisible(), true);
  assert.deepEqual(await pressed(page), ["true", "false", "false", "false"], "the first one starts out picked");
  assert.equal(await page.locator("#name").innerText(), ":a-happy-frog:");
  for (const id of ["#preview", "#inline", "#react"]) assert.equal(await printOf(page, id), t[0].print, `${id} shows the picked emoji`);
  for (const id of ["#download", "#copy", "#again"]) assert.equal(await page.locator(id).isEnabled(), true, id);
  assert.match(await page.locator("#device").innerText(), /graphics card/);
  assert.equal(await page.locator("#make").isEnabled(), true);
  assert.deepEqual(problems, []);
  await page.screenshot({ path: path.join(out, "desktop-results.png"), fullPage: true });
});

test("picking a tile and downloading gives a 128 px PNG that matches it pixel for pixel", async () => {
  const { page } = await open();
  await makeOne(page, "A Sleepy Cat!! (v2)");
  await waitStatus(page, "Painted. Tap another one to switch.");
  await page.locator(".tile").nth(2).click();
  assert.deepEqual(await pressed(page), ["false", "false", "true", "false"]);
  const third = (await readTiles(page))[2].print;
  for (const id of ["#preview", "#inline", "#react"]) assert.equal(await printOf(page, id), third, `${id} follows the pick`);
  assert.equal(await page.locator("#name").innerText(), ":a-sleepy-cat-v2:");

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

test("making again gives new emoji, goes back to the first one, and does not reload the model", async () => {
  const { page } = await open();
  await makeOne(page, "a rocket");
  await waitStatus(page, "Painted. Tap another one to switch.");
  const first = await readTiles(page);
  await page.locator(".tile").nth(3).click();
  await page.click("#make");
  await waitStatus(page, "Painted. Tap another one to switch.");
  const second = await readTiles(page);
  assert.notDeepEqual(first.map((t) => t.print), second.map((t) => t.print));
  const s = await page.evaluate(() => globalThis.__stub);
  assert.equal(s.loads, 1, "model loaded once");
  assert.equal(s.generates.length, 2);
  assert.notEqual(s.generates[0].seed, s.generates[1].seed);
  assert.deepEqual(await pressed(page), ["true", "false", "false", "false"]);
  assert.equal(await printOf(page, "#preview"), second[0].print);
});

test("Try again repaints the last prompt, even if the box was changed since", async () => {
  const { page } = await open();
  await makeOne(page, "a rocket");
  await waitStatus(page, "Painted. Tap another one to switch.");
  const first = await readTiles(page);
  await page.fill("#prompt", "something half typed");
  await page.click("#again");
  await page.waitForFunction(() => globalThis.__stub.generates.length === 2);
  await waitStatus(page, "Painted. Tap another one to switch.");
  const calls = await page.evaluate(() => globalThis.__stub.generates);
  assert.equal(calls[1].prompt, "a rocket");
  assert.notEqual(calls[0].seed, calls[1].seed);
  assert.equal(await page.inputValue("#prompt"), "a rocket");
  assert.notDeepEqual(first.map((t) => t.print), (await readTiles(page)).map((t) => t.print));
});

test("Copy puts the picked emoji on the clipboard as a 128 px PNG", async () => {
  const { page, context } = await open();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await makeOne(page, "a rocket");
  await waitStatus(page, "Painted. Tap another one to switch.");
  await page.locator(".tile").nth(1).click();
  await page.click("#copy");
  await waitStatus(page, "Copied.");
  const got = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const blob = await items[0].getType("image/png");
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    // Sample the middle of each 8 x 8 square to get the 16 x 16 sprite back.
    const small = [];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) small.push(...ctx.getImageData(x * 8 + 4, y * 8 + 4, 1, 1).data);
    return { types: items[0].types, w: bmp.width, h: bmp.height, small };
  });
  assert.deepEqual(got.types, ["image/png"]);
  assert.equal(got.w, 128);
  assert.equal(got.h, 128);
  const want = (await readTiles(page))[1].print.split(",").map(Number);
  let wrong = 0;
  for (let i = 0; i < want.length; i += 4) {
    if (want[i + 3] === 0 ? got.small[i + 3] !== 0 : want.slice(i, i + 4).join() !== got.small.slice(i, i + 4).join()) wrong++;
  }
  assert.equal(wrong, 0, "the copied picture matches the picked tile");
});

test("where pictures can't be copied, Copy says so and points to Download", async () => {
  const { page } = await open({ init: () => delete globalThis.ClipboardItem });
  await makeOne(page, "a rocket");
  await waitStatus(page, "Painted. Tap another one to switch.");
  await page.click("#copy");
  assert.match(await status(page), /can't copy pictures\. Use Download for Slack instead/);
  assert.equal(await page.locator("#status").getAttribute("data-kind"), "error");
});

test("a known name is swapped for that person's description, and the emoji keeps the name", async () => {
  const { page } = await open();
  await makeOne(page, "haim running");
  await waitStatus(page, "Painted. Tap another one to switch.");
  const calls = await page.evaluate(() => globalThis.__stub.generates);
  assert.equal(calls[0].prompt, "a bearded man with short dark hair and a gray scarf running", "what the model is asked for");
  assert.equal(await page.locator("#name").innerText(), ":haim-running:");
  assert.equal(await page.locator("#people-note").innerText(), "Haim is painted as a bearded man with short dark hair and a gray scarf.");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
  assert.equal(download.suggestedFilename(), "haim-running.png");

  // Try again must go through the same swap, from the name, not from the description.
  await page.click("#again");
  await page.waitForFunction(() => globalThis.__stub.generates.length === 2);
  await waitStatus(page, "Painted. Tap another one to switch.");
  assert.equal((await page.evaluate(() => globalThis.__stub.generates))[1].prompt, calls[0].prompt);
  assert.equal(await page.inputValue("#prompt"), "haim running");

  // A prompt without a name shows no note.
  await makeOne(page, "a rocket");
  await waitStatus(page, "Painted. Tap another one to switch.");
  assert.equal(await page.locator("#people-note").isHidden(), true);
  assert.equal((await page.evaluate(() => globalThis.__stub.generates))[2].prompt, "a rocket");
});

test("names match as whole words only, in any case, and odd names are safe", async () => {
  const { page } = await open();
  const r = await page.evaluate(async () => {
    const { expandPeople, PEOPLE } = await import("./people.js");
    const looks = PEOPLE.find((p) => p.name === "Haim").looks;
    const team = [{ name: "Ido", looks: "a tall man with glasses" }, { name: "C++ (Dana)", looks: "a woman with red hair" }, { name: "נועה", looks: "a girl with a hat" }];
    return {
      looks,
      words: looks.split(/\s+/).length,
      plain: expandPeople("Haim").text,
      nir: expandPeople("nir dancing").text,
      names: PEOPLE.map((p) => p.name),
      words2: ["a cat or a dog", "a dog that ran away", "OR gate", "an orange"].map((t) => expandPeople(t).text),
      or: expandPeople("Or drinking coffee").text,
      ran: expandPeople("happy Ran").text,
      dudu: expandPeople("DUDU waving").text,
      tal: expandPeople("tal").text,
      alon: expandPeople("alon").text,
      line: (await import("./people.js")).describePeople(),
      shown: document.querySelector("#known").textContent,
      notNir: [expandPeople("nirvana").text, expandPeople("a souvenir").text],
      everyone: PEOPLE.map((p) => ({ name: p.name, words: p.looks.split(/\s+/).length })),
      upper: expandPeople("HAIM dancing").text,
      twice: expandPeople("haim and Haim").text,
      inside: [expandPeople("Chaim running").text, expandPeople("haimish").text, expandPeople("haim2").text],
      punct: expandPeople("happy Haim, waving!").text,
      none: expandPeople("a red heart"),
      ido: expandPeople("ido and haim hugging", [...PEOPLE, ...team]),
      idol: expandPeople("an idol", team).text,
      odd: expandPeople("C++ (Dana) coding", team).text,
      hebrew: expandPeople("נועה smiling", team).text,
    };
  });
  assert.equal(r.plain, r.looks);
  assert.ok(r.words <= 12, `the description is short enough to leave room for the rest of the prompt (${r.words} words)`);
  assert.equal(r.nir, "a smiling man with brown hair, glasses and a blue shirt dancing");
  assert.deepEqual(r.names, ["Haim", "Nir", "Tal", "Alon", "Ran", "Or", "Dudu"]);
  // Or and Ran are English words too: only the capitalised form is the person.
  assert.deepEqual(r.words2, ["a cat or a dog", "a dog that ran away", "OR gate", "an orange"], "ordinary words are left alone");
  assert.equal(r.or, "a woman with dark hair tied back, earrings and a white t-shirt drinking coffee");
  assert.equal(r.ran, "happy a man with short dark hair, a dark beard and white t-shirt");
  assert.equal(r.dudu, "a bald man with glasses, a short beard and a gray coat waving");
  assert.equal(r.tal, "a man with ginger hair, a ginger beard and a dark jacket");
  assert.equal(r.alon, "a man with a dark quiff, short beard and black suit");
  assert.equal(r.line, "It knows these people by name: Haim, Nir, Tal, Alon, Ran, Or, Dudu. Write Ran and Or with a capital letter.");
  assert.equal(r.shown, r.line, "the page lists who it knows");
  assert.deepEqual(r.notNir, ["nirvana", "a souvenir"]);
  for (const p of r.everyone) assert.ok(p.words <= 12, `${p.name}: ${p.words} words`);
  assert.equal(new Set(r.everyone.map((p) => p.name.toLowerCase())).size, r.everyone.length, "no name is listed twice");
  assert.equal(r.upper, `${r.looks} dancing`);
  assert.equal(r.twice, `${r.looks} and ${r.looks}`);
  assert.deepEqual(r.inside, ["Chaim running", "haimish", "haim2"], "no match inside another word");
  assert.equal(r.punct, `happy ${r.looks}, waving!`);
  assert.deepEqual(r.none, { text: "a red heart", used: [] });
  assert.equal(r.ido.text, `a tall man with glasses and ${r.looks} hugging`);
  assert.deepEqual(r.ido.used.map((p) => p.name).sort(), ["Haim", "Ido"]);
  assert.equal(r.idol, "an idol");
  assert.equal(r.odd, "a woman with red hair coding");
  assert.equal(r.hebrew, "a girl with a hat smiling");
});

test("pressing Enter in the box works like the button", async () => {
  const { page } = await open();
  await page.fill("#prompt", "a red heart");
  await page.press("#prompt", "Enter");
  await waitStatus(page, "Painted. Tap another one to switch.");
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
  await waitStatus(page, "Painted. Tap another one to switch.");
  assert.equal((await page.evaluate(() => globalThis.__stub.generates)).length, 1);
});

test("a failed model download says why and can be retried", async () => {
  const { page } = await open({ init: () => (globalThis.__stubLoadFailures = 1) });
  await makeOne(page, "a rocket");
  await waitStatus(page, "That didn't work");
  assert.match(await status(page), /Couldn't download models\/tessera_w8\.onnx \(HTTP 404\)/);
  assert.equal(await page.locator("#status").getAttribute("data-kind"), "error");
  assert.equal(await page.locator("#progress").isHidden(), true);
  assert.equal(await page.locator("#results").isHidden(), true);
  assert.equal(await page.locator("#make").isEnabled(), true);
  await page.click("#make");
  await waitStatus(page, "Painted. Tap another one to switch.");
  assert.equal(await page.evaluate(() => globalThis.__stub.loads), 2);
});

test("a failed painting says why, clears the tiles, and the next try works", async () => {
  const { page } = await open();
  await makeOne(page, "a rocket");
  await waitStatus(page, "Painted. Tap another one to switch.");
  await makeOne(page, "please explode");
  await waitStatus(page, "That didn't work");
  assert.match(await status(page), /the stub was asked to fail/);
  for (const t of await readTiles(page)) assert.equal(t.painted, 0, "no stale emoji left behind");
  assert.equal(await page.locator("#results").isHidden(), true, "the old emoji are not left on screen");
  await makeOne(page, "a rocket");
  await waitStatus(page, "Painted. Tap another one to switch.");
  assert.equal(await page.locator(".tile").first().isEnabled(), true);
  assert.equal(await page.locator("#results").isVisible(), true);
});

test("without WebGPU it says it is painting on the processor", async () => {
  const { page } = await open({ init: () => (globalThis.__stubDevice = "cpu") });
  await makeOne(page, "a rocket");
  await waitStatus(page, "Painted. Tap another one to switch.");
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

test("on a phone-sized screen nothing overflows and everything is big enough to tap", async () => {
  const { page, problems } = await open({ viewport: { width: 380, height: 800 } });
  await makeOne(page, "a happy frog");
  await waitStatus(page, "Painted. Tap another one to switch.");
  await page.locator(".tile").nth(1).click();
  const m = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: innerWidth,
    tops: [...document.querySelectorAll(".tile")].map((t) => Math.round(t.getBoundingClientRect().top)),
    tile: document.querySelector(".tile").getBoundingClientRect().width,
    preview: document.querySelector("#preview").getBoundingClientRect().width,
    input: document.querySelector("#prompt").getBoundingClientRect().width,
    buttons: ["#make", "#download", "#copy", "#again"].map((b) => document.querySelector(b).getBoundingClientRect().height),
    backdrop: (() => {
      const c = document.querySelector("#backdrop");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let drawn = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) drawn++;
      // Does any icon pixel sit under the headline or the line below it?
      let underWords = 0;
      const k = c.width / c.getBoundingClientRect().width;
      for (const el of document.querySelectorAll(".masthead h1, .masthead .lede, .card")) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const box = c.getContext("2d").getImageData(r.left * k, (r.top + scrollY) * k, r.width * k, r.height * k).data;
        for (let i = 3; i < box.length; i += 4) if (box[i] > 0) underWords++;
      }
      return {
        share: drawn / (c.width * c.height),
        height: c.getBoundingClientRect().height,
        page: document.querySelector(".page").offsetHeight,
        underWords,
        ...globalThis.__backdrop,
      };
    })(),
  }));
  assert.ok(m.scroll <= m.inner, `no sideways scroll (${m.scroll} > ${m.inner})`);
  assert.equal(new Set(m.tops).size, 1, "the four choices sit in one row");
  assert.ok(m.tile >= 56, `each choice is big enough to tap (${m.tile}px)`);
  assert.ok(m.preview >= 160, "the large preview is large");
  assert.ok(m.input >= 180, "the text box stays usable");
  for (const b of m.buttons) assert.ok(b >= 44, "buttons are big enough to tap");
  assert.equal(m.backdrop.icons, 10, "ten different background icons");
  assert.ok(m.backdrop.placed >= 4, `icons show even on a phone (${m.backdrop.placed})`);
  assert.ok(m.backdrop.share > 0.001 && m.backdrop.share < 0.08, `the background stays sparse (${m.backdrop.share.toFixed(4)})`);
  assert.ok(m.backdrop.height >= m.backdrop.page, "the background reaches the bottom of the page");
  assert.equal(m.backdrop.underWords, 0, "no icon is cut off by a box or sits under the words");
  assert.deepEqual(problems, []);
  await page.screenshot({ path: path.join(out, "phone-results.png"), fullPage: true });
});

test("the keyboard alone can pick and download", async () => {
  const { page } = await open();
  await makeOne(page, "a rocket");
  await waitStatus(page, "Painted. Tap another one to switch.");
  await page.locator(".tile").nth(3).focus();
  await page.keyboard.press("Space");
  assert.equal(await page.locator(".tile").nth(3).getAttribute("aria-pressed"), "true");
  await page.locator("#download").focus();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
  assert.equal(download.suggestedFilename(), "a-rocket.png");
});

test("the sheet page paints four emoji for each prompt it is given", async () => {
  const { page, problems } = await open({ query: "sheet.html?p=Haim waving|a rocket&seed=3" });
  await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Done"), null, { timeout: 15_000 });
  assert.equal(await page.locator("#status").innerText(), "Done: 2 of 2 painted");
  assert.deepEqual(await page.locator(".sheet-label").allInnerTexts(), ["Haim waving", "a rocket"]);
  const calls = await page.evaluate(() => globalThis.__stub.generates);
  assert.deepEqual(calls.map((c) => [c.prompt, c.n, c.seed]), [
    ["a bearded man with short dark hair and a gray scarf waving", 4, 3],
    ["a rocket", 4, 3],
  ]);
  const painted = await page.evaluate(() =>
    [...document.querySelectorAll(".sheet-row canvas")].map((c) => {
      const d = c.getContext("2d").getImageData(0, 0, 16, 16).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    }),
  );
  assert.equal(painted.length, 8);
  for (const n of painted) assert.ok(n > 100, `painted ${n} px`);
  assert.deepEqual(problems, []);
});

test("the sheet page with no prompts paints everyone it knows", async () => {
  const { page } = await open({ query: "sheet.html" });
  await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Done"), null, { timeout: 20_000 });
  assert.deepEqual(await page.locator(".sheet-label").allInnerTexts(), ["Haim", "Nir", "Tal", "Alon", "Ran", "Or", "Dudu"]);
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

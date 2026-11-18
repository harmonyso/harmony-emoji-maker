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

test("a known name is rewritten into a description, action first, and the emoji keeps the name", async () => {
  const { page } = await open();
  await makeOne(page, "haim running");
  await waitStatus(page, "Painted. Tap another one to switch.");
  const calls = await page.evaluate(() => globalThis.__stub.generates);
  assert.equal(calls[0].prompt, "a man running, curly dark hair, brown beard, purple t-shirt", "what the model is asked for");
  assert.equal(await page.locator("#name").innerText(), ":haim-running:");
  assert.equal(await page.locator("#people-note").innerText(), "Haim is painted as a man: curly dark hair, brown beard, purple t-shirt.");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
  assert.equal(download.suggestedFilename(), "haim-running.png");

  // Try again must go through the same rewrite, from the name, not from the description.
  await page.click("#again");
  await page.waitForFunction(() => globalThis.__stub.generates.length === 2);
  await waitStatus(page, "Painted. Tap another one to switch.");
  assert.equal((await page.evaluate(() => globalThis.__stub.generates))[1].prompt, calls[0].prompt);
  assert.equal(await page.inputValue("#prompt"), "haim running");

  // Overriding a feature: the person's own hair is dropped, and the page says so.
  await makeOne(page, "Dudu with hair");
  await waitStatus(page, "Painted. Tap another one to switch.");
  assert.equal((await page.evaluate(() => globalThis.__stub.generates))[2].prompt, "a man with hair, glasses, short beard, purple t-shirt");
  assert.equal(
    await page.locator("#people-note").innerText(),
    "Dudu is painted as a man: glasses, short beard, purple t-shirt. Your prompt decides the hair.",
  );

  // A prompt without a name shows no note.
  await makeOne(page, "a rocket");
  await waitStatus(page, "Painted. Tap another one to switch.");
  assert.equal(await page.locator("#people-note").isHidden(), true);
  assert.equal((await page.evaluate(() => globalThis.__stub.generates))[3].prompt, "a rocket");
});

test("people: whole-word names, capital-only names, the action first, and overrides", async () => {
  const { page } = await open();
  const r = await page.evaluate(async () => {
    const { expandPeople, describePeople, explain, PEOPLE } = await import("./people.js");
    const t = (p, people) => expandPeople(p, people).text;
    const team = [
      { name: "Ido", noun: "man", features: [{ kind: "hair", text: "blond hair" }] },
      { name: "C++ (Dana)", noun: "woman", features: [{ kind: "hair", text: "red hair" }] },
      { name: "נועה", noun: "girl", features: [{ kind: "clothes", text: "yellow dress" }] },
    ];
    return {
      names: PEOPLE.map((p) => p.name),
      // every person, by name alone
      alone: Object.fromEntries(PEOPLE.map((p) => [p.name, t(p.name)])),
      // the action stays next to the person, the features go last
      waving: t("Tal waving"),
      upper: t("TAL dancing"),
      middle: t("happy Tal with a guitar"),
      afterWith: t("a dog with Tal"),
      punct: t("Tal, waving!"),
      // no match inside other words, and ordinary words are left alone
      inside: ["Chaim running", "haimish", "haim2", "nirvana", "a souvenir", "a cat or a dog", "a dog that ran away", "OR gate", "an orange"].map((p) => t(p)),
      none: expandPeople("a red heart"),
      or: t("Or drinking coffee"),
      ran: t("Ran pointing"),
      // overrides, one kind at a time
      hair: t("Dudu with hair"),
      longHair: t("Dudu with long blonde hair"),
      shaved: t("shaved Haim"),
      shades: t("Nir with sunglasses"),
      suit: t("Tal in a red suit"),
      hat: t("Tal wearing a hat"),
      two: expandPeople("Tal and Nir hugging"),
      // custom lists: odd characters and other alphabets
      idol: t("an idol", team),
      ido: t("ido jumping", team),
      odd: t("C++ (Dana) coding", team),
      hebrew: t("נועה smiling", team),
      line: describePeople(),
      shown: document.querySelector("#known").textContent,
      explained: expandPeople("Dudu with a red shirt and long hair").used.map(explain),
      colours: Object.fromEntries(
        PEOPLE.map((p) => [p.name, p.features.flatMap((f) => f.text.match(/\b(dark|black|brown|purple)\b/g) ?? [])]),
      ),
      plainBeards: PEOPLE.filter((p) => p.features.some((f) => f.text === "beard")).map((p) => p.name),
      longest: Math.max(...PEOPLE.map((p) => t(`${p.name} waving`).split(/\s+/).length)),
    };
  });
  assert.deepEqual(r.names, ["Haim", "Nir", "Tal", "Alon", "Ran", "Or", "Dudu"]);
  assert.deepEqual(r.alone, {
    Haim: "a man, curly dark hair, brown beard, purple t-shirt",
    Nir: "a man, brown hair, glasses, purple t-shirt",
    Tal: "a man, ginger hair, ginger beard, purple t-shirt",
    Alon: "a man, dark quiff, stubble, purple t-shirt",
    Ran: "a man, short dark hair, brown beard, purple t-shirt",
    Or: "a woman, dark hair tied back, earrings, purple t-shirt",
    Dudu: "a man, bald, glasses, short beard, purple t-shirt",
  });
  assert.equal(r.waving, "a man waving, ginger hair, ginger beard, purple t-shirt");
  assert.equal(r.upper, "a man dancing, ginger hair, ginger beard, purple t-shirt");
  assert.equal(r.middle, "happy man with a guitar, ginger hair, ginger beard, purple t-shirt");
  assert.equal(r.afterWith, "a dog with a man, ginger hair, ginger beard, purple t-shirt");
  assert.equal(r.punct, "a man, waving!, ginger hair, ginger beard, purple t-shirt");
  assert.deepEqual(r.inside, ["Chaim running", "haimish", "haim2", "nirvana", "a souvenir", "a cat or a dog", "a dog that ran away", "OR gate", "an orange"]);
  assert.deepEqual(r.none, { text: "a red heart", used: [] });
  assert.equal(r.or, "a woman drinking coffee, dark hair tied back, earrings, purple t-shirt");
  assert.equal(r.ran, "a man pointing, short dark hair, brown beard, purple t-shirt");
  assert.equal(r.hair, "a man with hair, glasses, short beard, purple t-shirt");
  assert.equal(r.longHair, "a man with long blonde hair, glasses, short beard, purple t-shirt");
  assert.equal(r.shaved, "shaved man, curly dark hair, purple t-shirt");
  assert.equal(r.shades, "a man with sunglasses, brown hair, purple t-shirt");
  assert.equal(r.suit, "a man in a red suit, ginger hair, ginger beard");
  assert.equal(r.hat, "a man wearing a hat, ginger hair, ginger beard, purple t-shirt", "a hat is not a change of clothes");
  assert.equal(r.two.text, "a man and a man hugging, brown hair, glasses, purple t-shirt, ginger hair, ginger beard");
  assert.deepEqual(r.two.used.map((p) => p.name).sort(), ["Nir", "Tal"]);
  assert.equal(r.idol, "an idol");
  assert.equal(r.ido, "a man jumping, blond hair");
  assert.equal(r.odd, "a woman coding, red hair");
  assert.equal(r.hebrew, "a girl smiling, yellow dress");
  assert.equal(
    r.line,
    "It knows these people by name: Haim, Nir, Tal, Alon, Ran, Or, Dudu. Write Ran and Or with a capital letter. " +
      "Poses, moods and things they wear work best: waving, laughing, with sunglasses. " +
      "Objects and scenes, like eating pizza or riding a rocket, mostly don't fit in a picture this small.",
  );
  assert.equal(r.shown, r.line, "the page lists who it knows");
  assert.deepEqual(r.explained, ["Dudu is painted as a man: glasses, short beard. Your prompt decides the hair and clothes."]);
  assert.ok(r.longest <= 11, `a name plus one action word stays short (${r.longest} words)`);
  for (const [name, colours] of Object.entries(r.colours)) {
    assert.equal(new Set(colours).size, colours.length, `${name} uses dark, black, brown or purple twice (${colours}): on the real model that smeared over the face`);
  }
  assert.deepEqual(r.plainBeards, [], "a beard with no colour takes the shirt's colour");
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

/** Decode a GIF in the page with the browser's own decoder. Returns frames as RGBA arrays. */
const DECODE_GIF = `async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dec = new ImageDecoder({ data: bytes, type: "image/gif" });
  await dec.tracks.ready;
  await dec.completed;
  const track = dec.tracks.selectedTrack;
  const frames = [];
  let w = 0, h = 0;
  for (let i = 0; i < track.frameCount; i++) {
    const { image } = await dec.decode({ frameIndex: i });
    w = image.displayWidth; h = image.displayHeight;
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d");
    ctx.drawImage(image, 0, 0);
    frames.push({ ms: image.duration / 1000, px: ctx.getImageData(0, 0, w, h).data });
    image.close();
  }
  return { w, h, loops: track.repetitionCount, frames };
}`;

const motionNow = (page) => page.inputValue("#move-style");

test("the motion comes from the prompt, and all four options move that way", async () => {
  const { page } = await open();
  assert.equal(await page.locator("#motion").isHidden(), true);
  await makeOne(page, "dudu walking");
  await waitStatus(page, "Painted. Tap another one to switch.");
  assert.equal(await page.locator("#motion").isVisible(), true);
  assert.equal(await page.locator(".motion-title").innerText(), "Make it");
  assert.deepEqual(await page.locator("#move-style option").allInnerTexts(), ["walk", "run", "jump", "dance", "wave", "float", "shake", "spin"]);
  assert.equal(await motionNow(page), "walk", "walking walks");
  assert.equal(await page.locator(".move").count(), 4, "one moving preview per painted option");

  // Each preview is its own option, in the walking motion: never some other motion.
  const check = async (effectId) =>
    page.evaluate(async (id) => {
      const { effectById, framesOf } = await import("./motion.js");
      const tiles = [...document.querySelectorAll(".tile canvas")].map((c) => c.getContext("2d").getImageData(0, 0, 16, 16).data);
      const want = tiles.map((px) => framesOf(effectById(id), px).map((f) => f.join()));
      const seen = tiles.map(() => new Set());
      for (let n = 0; n < 25; n++) {
        document.querySelectorAll(".move canvas").forEach((c, k) => seen[k].add(Array.from(c.getContext("2d").getImageData(0, 0, 20, 20).data).join()));
        await new Promise((r) => setTimeout(r, 40));
      }
      return seen.map((set, k) => ({ shown: set.size, allFromThisOption: [...set].every((f) => want[k].includes(f)), distinct: new Set(want[k]).size }));
    }, effectId);
  for (const [k, p] of (await check("walk")).entries()) {
    assert.ok(p.allFromThisOption, `preview ${k + 1} shows only walking frames of option ${k + 1}`);
    assert.ok(p.shown >= 2, `preview ${k + 1} is moving (${p.shown} frames seen)`);
  }

  for (const [prompt, want] of [
    ["Tal running", "run"],
    ["Or jumping", "jump"],
    ["Haim dancing", "dance"],
    ["Nir waving", "wave"],
    ["a flying rocket", "float"],
    ["an angry cat", "shake"],
    ["a spinning coin", "spin"],
    ["a red heart", "float"],
    ["Dudu waving while running", "wave"],
    ["Ran walking", "walk"],
  ]) {
    await makeOne(page, prompt);
    await waitStatus(page, "Painted. Tap another one to switch.");
    assert.equal(await motionNow(page), want, prompt);
  }
  for (const p of await check("walk")) assert.ok(p.allFromThisOption);

  // The menu changes the motion for all four at once.
  await page.selectOption("#move-style", "spin");
  for (const p of await check("spin")) assert.ok(p.allFromThisOption && p.shown >= 2);

  // Tapping a moving preview picks that emoji, the same as tapping the still one.
  await page.locator(".move").nth(2).click();
  assert.deepEqual(await pressed(page), ["false", "false", "true", "false"]);
  assert.deepEqual(await page.locator(".move").evaluateAll((els) => els.map((e) => e.getAttribute("aria-pressed"))), ["false", "false", "true", "false"]);
  await page.locator(".tile").nth(0).click();
  assert.deepEqual(await page.locator(".move").evaluateAll((els) => els.map((e) => e.getAttribute("aria-pressed"))), ["true", "false", "false", "false"]);

  // While it is painting again, the motion block is out of the way.
  await page.fill("#prompt", "a rocket");
  await page.click("#make");
  assert.equal(await page.locator("#motion").isHidden(), true);
  await waitStatus(page, "Painted. Tap another one to switch.");
});

test("each motion moves the picture the way its name says, and legs step when there are legs", async () => {
  const { page } = await open();
  const r = await page.evaluate(async () => {
    const { EFFECTS, FRAME, PAD, DEFAULT_EFFECT, effectById, effectFor, findLegs, framesOf, still } = await import("./motion.js");
    // Two hand-drawn pictures, as rows of letters: # is one colour, o another, . is empty.
    const draw = (rows) => {
      const px = new Uint8ClampedArray(16 * 16 * 4);
      rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== ".") px.set(ch === "#" ? [200, 30, 30, 255] : [30, 30, 200, 255], (y * 16 + x) * 4); }));
      return px;
    };
    const bust = draw([
      "....########....", "...##########...", "..############..", "..############..",
      "..############..", "..############..", "...##########...", "....########....",
      ".....######.....", "...oooooooooo...", "..oooooooooooo..", ".oooooooooooooo.",
      "oooooooooooooooo", "oooooooooooooooo", "oooooooooooooooo", "oooooooooooooooo",
    ]);
    const body = draw([
      "......####......", ".....######.....", ".....######.....", "......####......",
      "....oooooooo....", "...oooooooooo...", "...oooooooooo...", "...oooooooooo...",
      "....oooooooo....", "....oooooooo....", "....########....", "....###..###....",
      "....###..###....", "....###..###....", "...####..####...", "...####..####...",
    ]);
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const count = (px) => { let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i]) n++; return n; };
    const centre = (px) => { let n = 0, sx = 0, sy = 0; for (let i = 0; i < FRAME * FRAME; i++) if (px[i * 4 + 3]) { n++; sx += i % FRAME; sy += Math.floor(i / FRAME); } return { x: sx / n, y: sy / n }; };
    // The painted columns of one row of a frame, as a string like "..###..###..".
    const rowOf = (px, y) => Array.from({ length: FRAME }, (_, x) => (px[(y * FRAME + x) * 4 + 3] ? "#" : ".")).join("");
    const topRows = (px) => { let sx = 0, n = 0; for (let y = 0; y < PAD + 6; y++) for (let x = 0; x < FRAME; x++) if (px[(y * FRAME + x) * 4 + 3]) { sx += x; n++; } return sx / n; };
    const mirror = (px) => { const o = new Uint8ClampedArray(px.length); for (let y = 0; y < FRAME; y++) for (let x = 0; x < FRAME; x++) o.set(px.subarray((y * FRAME + FRAME - 1 - x) * 4, (y * FRAME + FRAME - x) * 4), (y * FRAME + x) * 4); return o; };
    const padded = new Uint8ClampedArray(FRAME * FRAME * 4);
    for (let y = 0; y < 16; y++) padded.set(bust.subarray(y * 64, y * 64 + 64), ((y + PAD) * FRAME + PAD) * 4);
    const base = centre(still(bust));
    const out = { frame: FRAME, pad: PAD, default: DEFAULT_EFFECT, stillIsPadded: same(still(bust), padded), ids: EFFECTS.map((e) => e.id), legsOfBust: findLegs(bust), legsOfBody: findLegs(body), motions: {} };
    for (const e of EFFECTS) {
      const f = framesOf(e, bust);
      out.motions[e.id] = {
        count: f.length,
        delay: e.delayMs,
        distinct: new Set(f.map((x) => x.join())).size,
        whole: f.map((x) => count(x) === count(bust)),
        up: f.map((x) => Math.round((base.y - centre(x).y) * 100) / 100),
        side: f.map((x) => Math.round((centre(x).x - base.x) * 100) / 100),
        head: f.map((x) => Math.round((topRows(x) - topRows(still(bust))) * 100) / 100),
        matchesStill: f.map((x) => same(x, padded)),
      };
    }
    const spin = framesOf(effectById("spin"), bust);
    out.spinHalfway = same(spin[6], mirror(padded));
    // Legs: the foot row of the full-body picture in each walking frame, and what a bust does.
    const walkBody = framesOf(effectById("walk"), body);
    const runBody = framesOf(effectById("run"), body);
    out.feet = { still: rowOf(still(body), PAD + 15), walk: walkBody.map((f, i) => rowOf(f, PAD + 15 - (i % 2))), run: runBody.map((f, i) => rowOf(f, PAD + 15 - (i % 2) * 2)) };
    out.bodyKeepsPixels = walkBody.map((f) => count(f));
    out.bodyCount = count(body);
    out.words = Object.fromEntries(["walking", "runs fast", "hopping", "at a party", "says hello", "swimming", "laughing", "dizzy", "sitting", "a cowalker", "Ran sleeping"].map((p) => [p, effectFor(p)]));
    return out;
  });
  assert.equal(r.frame, 20);
  assert.equal(r.pad, 2);
  assert.ok(r.stillIsPadded, "a still frame is the picture with two empty pixels all round");
  assert.deepEqual(r.ids, ["walk", "run", "jump", "dance", "wave", "float", "shake", "spin"]);
  assert.equal(r.default, "float");
  assert.deepEqual(r.words, { walking: "walk", "runs fast": "run", hopping: "jump", "at a party": "dance", "says hello": "wave", swimming: "float", laughing: "shake", dizzy: "spin", sitting: "float", "a cowalker": "float", "Ran sleeping": "float" });
  const m = r.motions;
  // Nothing but Jump's squash and Spin's turn may lose a pixel of the picture.
  for (const id of ["walk", "run", "dance", "wave", "float", "shake"]) assert.ok(m[id].whole.every(Boolean), `${id} never cuts the picture off`);
  assert.deepEqual(m.jump.whole, [false, true, true, true, true, true], "only the landing frame of a jump is squashed");
  // Walk: stand, step, stand, step.
  assert.deepEqual([m.walk.count, m.walk.delay], [4, 140]);
  assert.deepEqual(m.walk.matchesStill, [true, false, true, false]);
  assert.deepEqual(m.walk.up, [0, 1, 0, 1], "each step lifts the body one pixel");
  assert.ok(m.walk.head[1] < 0 && m.walk.head[3] > 0, "the head sways one way, then the other");
  // Run: twice as fast, leaning forward the whole time, twice as high.
  assert.deepEqual([m.run.count, m.run.delay], [4, 70]);
  assert.deepEqual(m.run.up, [0, 2, 0, 2]);
  assert.ok(m.run.head.every((h) => h > 0.5), "the head leads in every frame");
  assert.ok(m.run.matchesStill.every((x) => !x));
  // Jump, dance, wave, float, shake.
  assert.deepEqual(m.jump.up.slice(1), [1, 2, 2, 1, 0]);
  assert.deepEqual(m.dance.side.map(Math.sign), [-1, -1, 0, 1, 1, 0], "left, left, middle, right, right, middle");
  assert.ok(m.dance.side[0] <= -1 && m.dance.side[0] === -m.dance.side[3], "the sway is the same size both ways");
  assert.deepEqual(m.dance.up, [0, 1, 0, 0, 1, 0]);
  assert.deepEqual(m.wave.up, [0, 0, 0, 0], "waving stays on the ground");
  assert.ok(m.wave.head[0] < 0 && m.wave.head[2] > 0 && m.wave.matchesStill[1] && m.wave.matchesStill[3]);
  assert.deepEqual(m.float.up, [0, 1, 2, 2, 1, 0, -1, -1]);
  assert.ok(m.shake.count === 6 && m.shake.distinct >= 5 && m.shake.up.every((u) => Math.abs(u) <= 1) && m.shake.side.every((u) => Math.abs(u) <= 1));
  assert.deepEqual([m.spin.count, m.spin.matchesStill[0], r.spinHalfway], [12, true, true]);
  // Every motion is told apart from every other by its frames, not just its name.
  assert.equal(new Set(Object.values(m).map((x) => `${x.count}/${x.delay}/${x.up}/${x.side}/${x.head}`)).size, 8);
  // Legs.
  assert.equal(r.legsOfBust, null, "a head-and-shoulders picture has no legs to move");
  assert.deepEqual(r.legsOfBody, { top: 12, bottom: 15, split: 8 }, "the lowest four rows, split between the feet");
  assert.equal(r.feet.still, ".....####..####.....");
  assert.deepEqual(r.feet.walk, [".....####..####.....", "....####....####....", ".....####..####.....", "......########......"], "feet apart, then together");
  assert.deepEqual(r.feet.run, [".....####..####.....", "....####....####....", ".....####..####.....", "......########......"]);
  assert.ok(r.bodyKeepsPixels[1] === r.bodyCount, "striding out loses no pixels");
});

test("Download GIF gives a looping 120 px GIF of the picked emoji in the prompt's motion, frame by frame", async () => {
  const { page } = await open();
  await makeOne(page, "Dudu walking");
  await waitStatus(page, "Painted. Tap another one to switch.");
  await page.locator(".move").nth(1).click();
  for (const id of ["walk", "run", "jump", "dance", "wave", "float", "shake", "spin"]) {
    if (id !== "walk") await page.selectOption("#move-style", id);
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download-gif")]);
    assert.equal(download.suggestedFilename(), `dudu-walking-${id}.gif`);
    const file = path.join(out, `downloaded-${id}.gif`);
    await download.saveAs(file);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(0, 6).toString("latin1"), "GIF89a");
    assert.equal(bytes.readUInt16LE(6), 120);
    assert.equal(bytes.readUInt16LE(8), 120);
    assert.equal(bytes[bytes.length - 1], 0x3b, "ends with the GIF trailer");
    assert.ok(bytes.includes(Buffer.from("NETSCAPE2.0")), "has the loop marker");
    assert.ok(bytes.length < 128 * 1024, `under Slack's 128 KB limit (${bytes.length} bytes)`);
    const cmp = await page.evaluate(
      async ([b64, effectId, decodeSrc]) => {
        const decoded = await eval(decodeSrc)(b64);
        const { effectById, framesOf } = await import("./motion.js");
        const effect = effectById(effectId);
        const src = document.querySelectorAll(".tile canvas")[1].getContext("2d").getImageData(0, 0, 16, 16).data;
        const want = framesOf(effect, src);
        let wrong = 0;
        decoded.frames.forEach((f, n) => {
          for (let y = 0; y < 120; y++)
            for (let x = 0; x < 120; x++) {
              const g = (y * 120 + x) * 4;
              const s = (Math.floor(y / 6) * 20 + Math.floor(x / 6)) * 4;
              const w = want[n];
              if (w[s + 3] === 0 ? f.px[g + 3] !== 0 : f.px[g] !== w[s] || f.px[g + 1] !== w[s + 1] || f.px[g + 2] !== w[s + 2] || f.px[g + 3] !== 255) wrong++;
            }
        });
        return { w: decoded.w, h: decoded.h, loops: decoded.loops, n: decoded.frames.length, want: want.length, ms: decoded.frames.map((f) => f.ms), delay: effect.delayMs, wrong };
      },
      [bytes.toString("base64"), id, DECODE_GIF],
    );
    assert.equal(cmp.w, 120);
    assert.equal(cmp.h, 120);
    assert.equal(cmp.n, cmp.want, `${id}: every frame is in the file`);
    assert.equal(cmp.loops, Infinity, `${id}: loops forever`);
    assert.ok(cmp.ms.every((ms) => ms === cmp.delay), `${id}: frame time ${cmp.ms[0]} ms, wanted ${cmp.delay}`);
    assert.equal(cmp.wrong, 0, `${id}: every pixel of every frame matches`);
    assert.equal(await status(page), `Downloaded dudu-walking-${id}.gif`);
  }
});

test("the GIF writer survives the hard cases: a full palette, noise that fills its table, too many colours", async () => {
  const { page } = await open();
  const r = await page.evaluate(async (decodeSrc) => {
    const { encodeGif } = await import("./gif.js");
    const decode = eval(decodeSrc);
    const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
    let seed = 12345;
    const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const colour = (i) => [(i * 37) % 256, (i * 91 + 17) % 256, (i * 151 + 3) % 256];
    // 128 x 128 of pure noise in `n` colours plus see-through: far more patterns than the 4096-entry table holds.
    const noise = (n) => { const px = new Uint8ClampedArray(128 * 128 * 4); for (let i = 0; i < 128 * 128; i++) { const k = Math.floor(rand() * (n + 1)); if (k < n) px.set([...colour(k), 255], i * 4); } return px; };
    const exact = async (frames) => {
      const d = await decode(b64(encodeGif(frames, { grid: 128, scale: 1, delayMs: 100 })));
      let wrong = 0;
      frames.forEach((px, n) => { for (let i = 0; i < px.length; i += 4) { const f = d.frames[n].px; if (px[i + 3] === 0 ? f[i + 3] !== 0 : f[i] !== px[i] || f[i + 1] !== px[i + 1] || f[i + 2] !== px[i + 2] || f[i + 3] !== 255) wrong++; } });
      return { n: d.frames.length, wrong };
    };
    const full = await exact([noise(255), noise(255)]);
    const two = await exact([noise(2)]);
    const one = await exact([new Uint8ClampedArray(128 * 128 * 4).fill(255)]);
    const empty = await exact([new Uint8ClampedArray(128 * 128 * 4)]);
    // 400 colours cannot fit: it must still decode, with every pixel close to what was asked for.
    const many = noise(400);
    const d = await decode(b64(encodeGif([many], { grid: 128, scale: 1, delayMs: 100 })));
    let worst = 0, lostAlpha = 0;
    for (let i = 0; i < many.length; i += 4) {
      const f = d.frames[0].px;
      if ((many[i + 3] === 0) !== (f[i + 3] === 0)) lostAlpha++;
      else if (many[i + 3]) worst = Math.max(worst, Math.abs(f[i] - many[i]) + Math.abs(f[i + 1] - many[i + 1]) + Math.abs(f[i + 2] - many[i + 2]));
    }
    return { full, two, one, empty, many: { frames: d.frames.length, worst, lostAlpha } };
  }, DECODE_GIF);
  assert.deepEqual(r.full, { n: 2, wrong: 0 }, "255 colours of noise, two frames");
  assert.deepEqual(r.two, { n: 1, wrong: 0 }, "two colours of noise");
  assert.deepEqual(r.one, { n: 1, wrong: 0 }, "one flat colour");
  assert.deepEqual(r.empty, { n: 1, wrong: 0 }, "nothing but see-through");
  assert.equal(r.many.frames, 1);
  assert.equal(r.many.lostAlpha, 0);
  assert.ok(r.many.worst < 200, `too many colours fall back to a near one (worst miss ${r.many.worst})`);
});

test("for people who asked their device for less motion, the previews hold still but the GIF still downloads", async () => {
  const calm = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 900, height: 900 }, acceptDownloads: true });
  const page = await calm.newPage();
  await page.route("**/lib/client.js", (route) => route.fulfill({ contentType: "text/javascript", body: stub }));
  await page.goto(server.url);
  await page.fill("#prompt", "a rocket running");
  await page.click("#make");
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("Painted."));
  const still = new Set();
  for (let i = 0; i < 8; i++) {
    still.add(await page.evaluate(() => [...document.querySelectorAll(".move canvas")].map((c) => Array.from(c.getContext("2d").getImageData(0, 0, 20, 20).data).join()).join("|")));
    await page.waitForTimeout(60);
  }
  assert.equal(still.size, 1, "the previews do not animate");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download-gif")]);
  assert.equal(download.suggestedFilename(), "a-rocket-running-run.gif");
});

test("the sheet page paints four emoji for each prompt it is given", async () => {
  const { page, problems } = await open({ query: "sheet.html?p=Haim waving|a rocket&seed=3" });
  await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Done"), null, { timeout: 15_000 });
  assert.equal(await page.locator("#status").innerText(), "Done: 2 of 2 painted");
  assert.deepEqual(await page.locator(".sheet-label").allInnerTexts(), ["Haim waving", "a rocket"]);
  const calls = await page.evaluate(() => globalThis.__stub.generates);
  assert.deepEqual(calls.map((c) => [c.prompt, c.n, c.seed]), [
    ["a man waving, curly dark hair, brown beard, purple t-shirt", 4, 3],
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

// Real-model tests. They need the built site (bash scripts/fetch-upstream.sh), which holds the
// 115 MB of model files, and they run the model on the processor, so they take minutes.
// Run: node tests/model.test.mjs _site
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(process.argv[2] ?? "_site");
const out = path.join(here, "out");
fs.mkdirSync(out, { recursive: true });
for (const f of ["index.html", "app.js", "lib/client.js", "lib/engine.js", "models/tessera_w8.onnx", "models/clip_text_w8.onnx"]) {
  assert.ok(fs.existsSync(path.join(site, f)), `${f} is missing from ${site}. Run scripts/fetch-upstream.sh first.`);
}

const PAINT_TIMEOUT = 25 * 60_000;
const server = await serve(site);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });

async function open(query) {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()}`));
  // The model runtime prints its own notices to the console; show them without failing on them.
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log(`      [browser ${m.type()}] ${m.text().slice(0, 300)}`);
  });
  await page.goto(server.url + query);
  await page.waitForFunction(() => globalThis.__harmony);
  return { page, context, problems };
}

/** Paint one emoji through the page, exactly as a visitor would, and measure its colours. */
async function paint(prompt, seed, file) {
  const { page, context, problems } = await open(`?cpu&n=1&seed=${seed}`);
  const started = Date.now();
  await page.fill("#prompt", prompt);
  await page.click("#make");
  await page.waitForFunction(
    () => {
      const s = document.querySelector("#status");
      return s.textContent === "Painted." || s.dataset.kind === "error";
    },
    null,
    { timeout: PAINT_TIMEOUT, polling: 1000 },
  );
  const status = await page.locator("#status").innerText();
  assert.equal(status, "Painted.", `painting "${prompt}" ended with: ${status}\n${problems.join("\n")}`);
  const stats = await page.evaluate(() => {
    const d = document.querySelector(".tile canvas").getContext("2d").getImageData(0, 0, 16, 16).data;
    const colours = new Set();
    let painted = 0, red = 0, green = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      painted++;
      colours.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
      if (d[i] > 120 && d[i] > d[i + 1] * 1.5 && d[i] > d[i + 2] * 1.5) red++;
      if (d[i + 1] > 90 && d[i + 1] > d[i] * 1.15 && d[i + 1] > d[i + 2] * 1.15) green++;
    }
    return { painted, colours: colours.size, red, green, print: Array.from(d).join(",") };
  });
  const device = await page.locator("#device").innerText();
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
  await download.saveAs(path.join(out, file));
  await page.screenshot({ path: path.join(out, file.replace(".png", "-page.png")), fullPage: true });
  await context.close();
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`      "${prompt}" seed ${seed}: ${seconds}s, ${stats.painted} px painted, ${stats.colours} colours, ${stats.red} red, ${stats.green} green`);
  return { ...stats, device, problems, seconds };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("the downloaded model gives the reference output for the reference prompt", async () => {
  // The same check the app runs on a graphics card, done here on the processor: one pass of
  // both models on a fixed prompt, compared with numbers the model's porter saved.
  const { page, context } = await open("?n=1");
  const r = await page.evaluate(async () => {
    const DIR = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
    const ort = await import(`${DIR}ort.webgpu.min.mjs`);
    ort.env.wasm.wasmPaths = DIR;
    const N = 256, K = 512, MASK = 512, TEXT_LEN = 24;
    const ref = await (await fetch("models/selftest.json")).json();
    const opts = {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
      extra: { optimization: { disable_specified_optimizers: "ConstantFolding" } },
    };
    const bytes = async (p) => new Uint8Array(await (await fetch(p)).arrayBuffer());
    const den = await ort.InferenceSession.create(await bytes("models/tessera_w8.onnx"), opts);
    const clip = await ort.InferenceSession.create(await bytes("models/clip_text_w8.onnx"), opts);
    const text = await clip.run({ input_ids: new ort.Tensor("int64", BigInt64Array.from(ref.ids, BigInt), [1, TEXT_LEN]) });
    const o = await den.run({
      x: new ort.Tensor("int64", new BigInt64Array(N).fill(BigInt(MASK)), [1, N]),
      text_states: text.last_hidden_state,
      text_pooled: text.pooler_output,
      mask_ratio: new ort.Tensor("float32", new Float32Array([1]), [1]),
      sc_probs: new ort.Tensor("float32", new Float32Array(N * K), [1, N, K]),
      drop_text: new ort.Tensor("bool", new Uint8Array(1), [1]),
    });
    const logits = o.logits.data;
    let agree = 0, topDiff = 0, bad = 0;
    for (let i = 0; i < N; i++) {
      let best = 0;
      for (let j = 0; j < K; j++) {
        const v = logits[i * K + j];
        if (!Number.isFinite(v)) bad++;
        if (v > logits[i * K + best]) best = j;
      }
      if (best === ref.argmax[i]) agree++;
      topDiff += Math.abs(logits[i * K + best] - ref.top[i]);
    }
    return { ids: ref.ids.length, size: logits.length, bad, agreement: agree / N, meanTopDiff: topDiff / N };
  });
  console.log(`      agreement ${r.agreement.toFixed(3)}, mean top-logit error ${r.meanTopDiff.toFixed(4)}`);
  assert.equal(r.ids, 24);
  assert.equal(r.size, 256 * 512);
  assert.equal(r.bad, 0, "no NaN or infinite outputs");
  assert.ok(r.agreement >= 0.8, `agreement ${r.agreement}`);
  assert.ok(r.meanTopDiff <= 0.5, `top-logit error ${r.meanTopDiff}`);
  await context.close();
});

let heart, frog;

test("the page paints a real emoji from a prompt, start to finish", async () => {
  heart = await paint("a red heart", 7, "real-a-red-heart.png");
  assert.match(heart.device, /processor/, "this test runs on the processor");
  assert.ok(heart.painted >= 20, `only ${heart.painted} pixels painted`);
  assert.ok(heart.colours >= 2, `only ${heart.colours} colours`);
  assert.deepEqual(heart.problems, []);
});

test("the prompt steers the picture: a red heart is redder, a green frog is greener", async () => {
  frog = await paint("a green frog", 7, "real-a-green-frog.png");
  assert.ok(frog.painted >= 20, `only ${frog.painted} pixels painted`);
  assert.notEqual(heart.print, frog.print, "different prompts give different pictures");
  assert.ok(heart.red > frog.red, `heart has ${heart.red} red px, frog has ${frog.red}`);
  assert.ok(frog.green > heart.green, `frog has ${frog.green} green px, heart has ${heart.green}`);
  assert.deepEqual(frog.problems, []);
});

test("the same prompt and seed paint the same emoji again", async () => {
  const again = await paint("a red heart", 7, "real-a-red-heart-again.png");
  assert.equal(again.print, heart.print);
});

test("a prompt with a known name paints a picture too", async () => {
  const haim = await paint("Haim waving", 7, "real-haim-waving.png");
  assert.ok(haim.painted >= 20, `only ${haim.painted} pixels painted`);
  assert.ok(haim.colours >= 3, `only ${haim.colours} colours`);
  assert.notEqual(haim.print, heart.print);
  assert.deepEqual(haim.problems, []);
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
}
await browser.close();
await server.close();
console.log(`\n${tests.length - failed} of ${tests.length} passed`);
process.exit(failed ? 1 : 0);

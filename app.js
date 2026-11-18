// Harmony emoji maker: the page around the model.
// The model, sampler and downloads live in ./lib (from cfahlgren1/slack-moji, see README).

import { loadEngine, crashedLastTime, GRID, N } from "./lib/client.js";

const EXPORT_SIZE = 128; // Slack's recommended emoji size
const STEPS = 16;
const MASKED = [0, 0, 0, 0]; // not painted yet: show the tile's checkerboard

const params = new URLSearchParams(location.search);
const COUNT = Math.min(4, Math.max(1, Number.parseInt(params.get("n") ?? "4", 10) || 4));
// ?seed=123 repeats the same emoji for the same prompt. Without it every run is new.
const FIXED_SEED = /^\d{1,10}$/.test(params.get("seed") ?? "") ? Number(params.get("seed")) >>> 0 : null;

const $ = (id) => document.getElementById(id);
const els = {
  form: $("ask"),
  prompt: $("prompt"),
  make: $("make"),
  hint: $("hint"),
  progress: $("progress"),
  bar: document.querySelector(".bar"),
  fill: $("bar-fill"),
  status: $("status"),
  tiles: $("tiles"),
  actions: $("actions"),
  download: $("download"),
  device: $("device"),
};

let client = null;
let busy = false;
let result = null; // { x, prompt, seed } of the sprites on screen
let picked = -1;

const tiles = [];
for (let i = 0; i < COUNT; i++) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tile";
  button.disabled = true;
  button.setAttribute("aria-pressed", "false");
  button.setAttribute("aria-label", `Option ${i + 1}`);
  const canvas = document.createElement("canvas");
  canvas.width = GRID;
  canvas.height = GRID;
  button.append(canvas);
  button.addEventListener("click", () => pick(i));
  els.tiles.append(button);
  tiles.push({ button, canvas, ctx: canvas.getContext("2d") });
}
els.tiles.dataset.count = String(COUNT);
els.make.textContent = `Make ${COUNT}`;

function setStatus(text, kind = "info") {
  els.status.textContent = text;
  els.status.dataset.kind = kind;
}

function setBar(fraction) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  els.fill.style.width = `${pct}%`;
  els.bar.setAttribute("aria-valuenow", String(pct));
}

function pick(i) {
  picked = i;
  tiles.forEach((t, b) => t.button.setAttribute("aria-pressed", String(b === i)));
  els.tiles.dataset.picked = String(i >= 0);
  els.download.disabled = i < 0;
}

function paint(x, masked) {
  tiles.forEach((t, b) => {
    t.ctx.putImageData(new ImageData(client.toRGBA(x, masked, b, MASKED), GRID, GRID), 0, 0);
  });
}

function clearTiles() {
  tiles.forEach((t) => t.ctx.clearRect(0, 0, GRID, GRID));
}

function setBusy(on) {
  busy = on;
  els.make.disabled = on;
  els.prompt.readOnly = on;
  tiles.forEach((t) => (t.button.disabled = on || !result));
}

const megabytes = (bytes) => Math.round(bytes / 1e6);

function onLoadProgress({ stage, loaded, total }) {
  els.progress.hidden = false;
  if (stage === "download") {
    setBar(loaded / total);
    setStatus(`Downloading the model: ${megabytes(loaded)} of ${megabytes(total)} MB`);
  } else if (stage === "load") {
    setBar(1);
    setStatus("Loading the model into memory");
  } else if (stage === "check") {
    setBar(1);
    setStatus("Checking your graphics card");
  }
}

function describeDevice(c) {
  if (c.device === "webgpu") return "Painting on your graphics card.";
  const why = {
    "no-webgpu": "This browser has no WebGPU, so it paints on your processor.",
    "gpu-error": "Your graphics card couldn't start the model, so it paints on your processor.",
    "gpu-bad-output": "Your graphics card gave wrong results, so it paints on your processor.",
    forced: "Painting on your processor.",
  };
  return `${why[c.fallbackReason] ?? "Painting on your processor."} That is slower: one batch can take a few minutes.`;
}

async function ensureClient() {
  if (client) return client;
  setBar(0);
  els.progress.hidden = false;
  try {
    client = await loadEngine(onLoadProgress);
  } finally {
    els.progress.hidden = true;
  }
  els.hint.textContent = "Write in English. Short, concrete descriptions work best.";
  els.device.textContent = describeDevice(client);
  return client;
}

function readPrompt() {
  return els.prompt.value.trim().replace(/\s+/g, " ");
}

async function make() {
  if (busy) return;
  const prompt = readPrompt();
  if (!prompt) {
    setStatus("Type what the emoji should be first.", "error");
    els.prompt.focus();
    return;
  }

  result = null;
  pick(-1);
  els.actions.hidden = true;
  setBusy(true);
  try {
    const c = await ensureClient();
    clearTiles();
    setStatus(COUNT > 1 ? `Painting ${COUNT} emoji` : "Painting your emoji");
    const seed = FIXED_SEED ?? crypto.getRandomValues(new Uint32Array(1))[0];
    const x = await c.generate(prompt, {
      n: COUNT,
      seed,
      onStep: (step, tokens, masked) => {
        paint(tokens, masked);
        setStatus(`Painting, step ${Math.min(step + 1, STEPS)} of ${STEPS}`);
      },
    });
    paint(x, null);
    result = { x, prompt, seed };
    els.actions.hidden = false;
    if (COUNT === 1) pick(0);
    setStatus(COUNT > 1 ? "Tap the one you like." : "Painted.");
  } catch (err) {
    console.error(err);
    if (client) clearTiles();
    setStatus(`That didn't work: ${err?.message ?? err}`, "error");
  } finally {
    setBusy(false);
  }
}

/** Slack emoji names allow lowercase letters, numbers, dashes and underscores. */
export function slug(text) {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || "emoji";
}

/** Blow one 16 x 16 sprite up to `size` pixels with hard edges: every sprite pixel becomes a square. */
export function upscale(px, grid, size) {
  const scale = size / grid;
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < size; x++) {
      const s = (sy * grid + Math.floor(x / scale)) * 4;
      out.set(px.subarray(s, s + 4), (y * size + x) * 4);
    }
  }
  return out;
}

function download() {
  if (!result || picked < 0) return;
  const px = client.toRGBA(result.x, null, picked, MASKED);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = EXPORT_SIZE;
  canvas.getContext("2d").putImageData(new ImageData(upscale(px, GRID, EXPORT_SIZE), EXPORT_SIZE, EXPORT_SIZE), 0, 0);
  const name = `${slug(result.prompt)}.png`;
  canvas.toBlob((blob) => {
    if (!blob) {
      setStatus("Your browser couldn't create the image file.", "error");
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    setStatus(`Downloaded ${name}`);
  }, "image/png");
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  make();
});
els.download.addEventListener("click", download);
document.querySelectorAll("[data-idea]").forEach((b) =>
  b.addEventListener("click", () => {
    if (busy) return;
    els.prompt.value = b.dataset.idea;
    els.prompt.focus();
  }),
);

if (crashedLastTime()) {
  setStatus("Last time, this device ran out of memory while loading the model. You can try again, but it may not fit.", "error");
}

// Lets the tests and the curious check which sprite sizes this build uses.
globalThis.__harmony = { GRID, N, COUNT, EXPORT_SIZE };

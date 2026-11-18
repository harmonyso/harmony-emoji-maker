// Harmony emoji maker: the page around the model.
// The model, sampler and downloads live in ./lib (fetched at build time, see README for credits).

import { loadEngine, crashedLastTime, GRID, N } from "./lib/client.js";
import { expandPeople, describePeople, explain } from "./people.js";
import { DEFAULT_EFFECT, EFFECTS, FRAME, effectById, effectFor, framesOf } from "./motion.js";
import { encodeGif } from "./gif.js";

const EXPORT_SIZE = 128; // Slack's recommended emoji size
const STEPS = 16;
const MASKED = [0, 0, 0, 0]; // not painted yet: leave the pixel empty

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
  peopleNote: $("people-note"),
  results: $("results"),
  name: $("name"),
  tiles: $("tiles"),
  actions: $("actions"),
  download: $("download"),
  copy: $("copy"),
  again: $("again"),
  motion: $("motion"),
  moves: $("moves"),
  moveStyle: $("move-style"),
  downloadGif: $("download-gif"),
  device: $("device"),
};
// The picked emoji is shown three more times: large, inside the chat line, and as a reaction.
const mirrors = ["preview", "inline", "react"].map((id) => $(id).getContext("2d"));

let client = null;
let busy = false;
let result = null; // { x, prompt, seed } of the sprites on screen
let picked = 0;

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
$("known").textContent = describePeople();
els.make.textContent = `Make ${COUNT}`;

// Under the stills, the same four options again, moving. The motion comes from the prompt
// ("Dudu walking" walks); the menu is for changing it.
const stillLife = matchMedia("(prefers-reduced-motion: reduce)");
for (const effect of EFFECTS) els.moveStyle.append(new Option(effect.label.toLowerCase(), effect.id));
const moves = tiles.map((_tile, i) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "move";
  button.setAttribute("aria-pressed", "false");
  button.setAttribute("aria-label", `Option ${i + 1}, moving`);
  const canvas = document.createElement("canvas");
  canvas.width = FRAME;
  canvas.height = FRAME;
  button.append(canvas);
  button.addEventListener("click", () => pick(i));
  els.moves.append(button);
  return { button, ctx: canvas.getContext("2d"), frames: [], shown: -1 };
});
els.moves.dataset.count = String(COUNT);
let move = DEFAULT_EFFECT;
let ticking = 0;

function setMove(id) {
  move = id;
  els.moveStyle.value = id;
  refreshMoves();
}

/** Remake every option's frames in the current motion. */
function refreshMoves() {
  if (!result) return;
  const effect = effectById(move);
  moves.forEach((m, b) => {
    m.frames = framesOf(effect, client.toRGBA(result.x, null, b, MASKED));
    m.shown = -1;
  });
  drawMoves(performance.now());
}

function drawMoves(now) {
  const effect = effectById(move);
  for (const m of moves) {
    if (!m.frames.length) continue;
    // People who asked their device for less motion get a still frame; the GIF still moves.
    const i = stillLife.matches ? Math.min(1, m.frames.length - 1) : Math.floor(now / effect.delayMs) % m.frames.length;
    if (i === m.shown) continue;
    m.shown = i;
    m.ctx.putImageData(new ImageData(m.frames[i], FRAME, FRAME), 0, 0);
  }
}

function tick(now) {
  ticking = 0;
  if (els.motion.hidden || els.results.hidden) return;
  drawMoves(now);
  if (!stillLife.matches) ticking = requestAnimationFrame(tick);
}

function startMoves() {
  refreshMoves();
  if (!ticking) ticking = requestAnimationFrame(tick);
}

function setStatus(text, kind = "info") {
  els.status.textContent = text;
  els.status.dataset.kind = kind;
}

function setBar(fraction) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  els.fill.style.width = `${pct}%`;
  els.bar.setAttribute("aria-valuenow", String(pct));
}

/** Copy the picked tile onto the large preview, the chat line and the reaction. */
function mirror() {
  for (const ctx of mirrors) {
    ctx.clearRect(0, 0, GRID, GRID);
    ctx.drawImage(tiles[picked].canvas, 0, 0);
  }
}

function pick(i) {
  picked = i;
  tiles.forEach((t, b) => t.button.setAttribute("aria-pressed", String(b === i)));
  moves.forEach((m, b) => m.button.setAttribute("aria-pressed", String(b === i)));
  mirror();
}

function paint(x, masked) {
  tiles.forEach((t, b) => {
    t.ctx.putImageData(new ImageData(client.toRGBA(x, masked, b, MASKED), GRID, GRID), 0, 0);
  });
  mirror();
}

function clearTiles() {
  tiles.forEach((t) => t.ctx.clearRect(0, 0, GRID, GRID));
  mirror();
}

function setBusy(on) {
  busy = on;
  els.make.disabled = on;
  els.prompt.readOnly = on;
  tiles.forEach((t) => (t.button.disabled = on || !result));
  els.actions.hidden = on || !result;
  els.motion.hidden = on || !result;
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
  return `${why[c.fallbackReason] ?? "Painting on your processor."} That is slower: one batch can take a minute or more.`;
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

  // A known name ("Haim") is rewritten into a description; the model can't read names.
  const { text, used } = expandPeople(prompt);
  els.peopleNote.textContent = used.map(explain).join(" ");

  result = null;
  setBusy(true);
  try {
    const c = await ensureClient();
    pick(0);
    clearTiles();
    els.name.textContent = `:${slug(prompt)}:`;
    els.results.hidden = false;
    setStatus(COUNT > 1 ? `Painting ${COUNT} emoji` : "Painting your emoji");
    const seed = FIXED_SEED ?? crypto.getRandomValues(new Uint32Array(1))[0];
    const x = await c.generate(text, {
      n: COUNT,
      seed,
      onStep: (step, tokens, masked) => {
        paint(tokens, masked);
        setStatus(`Painting, step ${Math.min(step + 1, STEPS)} of ${STEPS}`);
      },
    });
    paint(x, null);
    result = { x, prompt, seed };
    setMove(effectFor(prompt));
    setStatus(COUNT > 1 ? "Painted. Tap another one to switch." : "Painted.");
  } catch (err) {
    console.error(err);
    if (client) clearTiles();
    els.results.hidden = true;
    setStatus(`That didn't work: ${err?.message ?? err}`, "error");
  } finally {
    setBusy(false);
    if (result) startMoves();
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

/** The picked emoji as a 128 px PNG file. */
function exportPng() {
  const px = client.toRGBA(result.x, null, picked, MASKED);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = EXPORT_SIZE;
  canvas.getContext("2d").putImageData(new ImageData(upscale(px, GRID, EXPORT_SIZE), EXPORT_SIZE, EXPORT_SIZE), 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no image"))), "image/png"),
  );
}

function save(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  setStatus(`Downloaded ${name}`);
}

async function download() {
  if (!result || busy) return;
  try {
    save(await exportPng(), `${slug(result.prompt)}.png`);
  } catch {
    setStatus("Your browser couldn't create the image file.", "error");
  }
}

/**
 * The picked emoji, in the current motion, as a GIF that loops forever. Frames are 20 pixels
 * wide (the picture plus room to move), so at 6x the file is 120 x 120, inside Slack's 128 limit.
 */
function downloadGif() {
  if (!result || busy) return;
  const effect = effectById(move);
  const px = client.toRGBA(result.x, null, picked, MASKED);
  const bytes = encodeGif(framesOf(effect, px), { grid: FRAME, scale: Math.floor(EXPORT_SIZE / FRAME), delayMs: effect.delayMs });
  save(new Blob([bytes], { type: "image/gif" }), `${slug(result.prompt)}-${effect.id}.gif`);
}

async function copy() {
  if (!result || busy) return;
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    setStatus("This browser can't copy pictures. Use Download for Slack instead.", "error");
    return;
  }
  try {
    // Handing over a promise, not a finished file, is what Safari needs to allow the copy.
    await navigator.clipboard.write([new ClipboardItem({ "image/png": exportPng() })]);
    setStatus("Copied. Paste it into a chat or a document.");
  } catch {
    setStatus("The browser blocked the copy. Use Download for Slack instead.", "error");
  }
}

function again() {
  if (!result || busy) return;
  els.prompt.value = result.prompt;
  make();
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  make();
});
els.download.addEventListener("click", download);
els.copy.addEventListener("click", copy);
els.again.addEventListener("click", again);
els.downloadGif.addEventListener("click", downloadGif);
els.moveStyle.addEventListener("change", () => setMove(els.moveStyle.value));
stillLife.addEventListener("change", startMoves);
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

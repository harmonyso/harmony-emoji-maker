// A comparison sheet: four emoji for each of several prompts. Used to check how a person's
// description comes out before it goes into people.js. See sheet.html for how to call it.

import { loadEngine, GRID } from "./lib/client.js";
import { PEOPLE, expandPeople } from "./people.js";

const params = new URLSearchParams(location.search);
const prompts = (params.get("p") ?? "")
  .split("|")
  .map((p) => p.trim())
  .filter(Boolean);
const list = prompts.length ? prompts : PEOPLE.map((p) => p.name);
const seed = /^\d{1,10}$/.test(params.get("seed") ?? "") ? Number(params.get("seed")) >>> 0 : 7;

const status = document.getElementById("status");
const rows = document.getElementById("rows");

async function run() {
  status.textContent = "Loading the model";
  const client = await loadEngine(({ stage, loaded, total }) => {
    status.textContent = stage === "download" ? `Downloading the model: ${Math.round((loaded / total) * 100)}%` : "Loading the model";
  });
  for (const [i, prompt] of list.entries()) {
    const { text } = expandPeople(prompt);
    const label = document.createElement("p");
    label.className = "sheet-label";
    label.textContent = prompt;
    const sub = document.createElement("p");
    sub.className = "sheet-text";
    sub.textContent = text === prompt ? "" : text;
    const row = document.createElement("div");
    row.className = "sheet-row";
    const ctxs = Array.from({ length: 4 }, () => {
      const c = document.createElement("canvas");
      c.width = c.height = GRID;
      row.append(c);
      return c.getContext("2d");
    });
    rows.append(label, sub, row);
    status.textContent = `Painting ${i + 1} of ${list.length}: ${prompt}`;
    const paint = (x, masked) =>
      ctxs.forEach((ctx, b) => ctx.putImageData(new ImageData(client.toRGBA(x, masked, b, [0, 0, 0, 0]), GRID, GRID), 0, 0));
    paint(await client.generate(text, { n: 4, seed, onStep: (_step, x, masked) => paint(x, masked) }), null);
  }
  status.textContent = `Done: ${list.length} of ${list.length} painted`;
}

run().catch((err) => {
  console.error(err);
  status.dataset.kind = "error";
  status.textContent = `That didn't work: ${err?.message ?? err}`;
});

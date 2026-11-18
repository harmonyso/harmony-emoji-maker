// Stand-in for lib/client.js in the UI tests. It has the same exports and the same call
// shapes as the real one (see README), but paints made-up sprites instantly, so the
// page can be tested without the 115 MB model. The real model is tested in model.test.mjs.

export const GRID = 16;
export const N = GRID * GRID;
const K = 512;
const TOTAL = 50840032 + 64060515;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function crashedLastTime() {
  try {
    return localStorage.getItem("slack-moji:loading") === "1";
  } catch {
    return false;
  }
}

export async function loadEngine(onProgress) {
  globalThis.__stub = globalThis.__stub ?? { loads: 0, generates: [] };
  globalThis.__stub.loads++;
  for (const f of [0.1, 0.55, 1]) {
    onProgress?.({ stage: "download", loaded: Math.round(TOTAL * f), total: TOTAL });
    await sleep(30);
  }
  if (globalThis.__stubLoadFailures > 0) {
    globalThis.__stubLoadFailures--;
    throw new Error("Couldn't download models/tessera_w8.onnx (HTTP 404)");
  }
  onProgress?.({ stage: "load", loaded: TOTAL, total: TOTAL });
  await sleep(30);
  onProgress?.({ stage: "check", loaded: TOTAL, total: TOTAL });
  await sleep(30);

  // Token 0 is transparent, like the real palette; the rest are opaque colours.
  const palette = new Uint8ClampedArray(K * 4);
  const rand = mulberry32(7);
  for (let i = 1; i < K; i++) palette.set([rand() * 256, rand() * 256, rand() * 256, 255], i * 4);
  const device = globalThis.__stubDevice ?? "webgpu";
  return new Client(palette, device, device === "webgpu" ? null : "no-webgpu");
}

class Client {
  constructor(palette, device, fallbackReason) {
    this.palette = palette;
    this.device = device;
    this.fallbackReason = fallbackReason;
  }

  async generate(prompt, { n = 4, seed = 0, onStep } = {}) {
    globalThis.__stub.generates.push({ prompt, n, seed });
    if (prompt.includes("explode")) throw new Error("the stub was asked to fail");
    const rand = mulberry32(seed);
    const x = new Int32Array(n * N);
    for (let i = 0; i < x.length; i++) x[i] = rand() < 0.3 ? 0 : 1 + Math.floor(rand() * (K - 1));
    const order = Array.from({ length: N }, (_, i) => i).sort(() => rand() - 0.5);
    for (let step = 0; step < 16; step++) {
      const masked = new Uint8Array(n * N);
      const shown = Math.floor(((step + 1) / 16) * N);
      for (let b = 0; b < n; b++) for (let j = shown; j < N; j++) masked[b * N + order[j]] = 1;
      await onStep?.(step, x.slice(), masked);
      await sleep(5);
    }
    return x;
  }

  toRGBA(x, masked, b, maskColor = [220, 220, 225, 255]) {
    const px = new Uint8ClampedArray(N * 4);
    for (let i = 0; i < N; i++) {
      if (masked && masked[b * N + i]) px.set(maskColor, i * 4);
      else px.set(this.palette.subarray(x[b * N + i] * 4, x[b * N + i] * 4 + 4), i * 4);
    }
    return px;
  }
}

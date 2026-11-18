// The page background: small pixel-art icons about harmony (music, peace, balance, friendship),
// faded and scattered at slight angles wherever the page is empty: above the headline, down the
// sides, and below the last box. A still picture, redrawn only when the page changes shape.
// All icons are drawn here, by hand, as rows of letters.

const COLOURS = {
  k: "#2a2545", // outline
  w: "#ffffff",
  r: "#e8505b",
  R: "#b93a48",
  p: "#ff9fb0",
  y: "#ffc531",
  o: "#f08a3c",
  g: "#4fb477",
  b: "#4f8df5",
  v: "#7b5cf5",
  V: "#5b3df5",
  s: "#9aa0b5",
};

const ICONS = {
  heart: [
    "..kk...kk..",
    ".krrk.krrk.",
    "krprrkrrrrk",
    "krprrrrrrrk",
    "krrrrrrrrRk",
    ".krrrrrrRk.",
    "..krrrrRk..",
    "...krrRk...",
    "....krk....",
    ".....k.....",
  ],
  note: [
    "....kkkkk",
    "....kvvvk",
    "....kvkkk",
    "....kvk..",
    "....kvk..",
    "....kvk..",
    "....kvk..",
    ".kkkkvk..",
    "kvvvvvk..",
    "kvvvvvk..",
    "kvvvvvk..",
    ".kvvvk...",
    "..kkk....",
  ],
  notes: [
    "....kkkkkkkkk",
    "....kyyyyyyyk",
    "....kyyyyyyyk",
    "....kykkkkkyk",
    "....kyk...kyk",
    "....kyk...kyk",
    "....kyk...kyk",
    ".kkkkyk.kkkyk",
    "kyyyyykkyyyyk",
    "kyyyyykkyyyyk",
    ".kyyyk..kyyk.",
    "..kkk....kk..",
  ],
  yinYang: [
    "....kkkk....",
    "..kkwwwwkk..",
    ".kwwwwwwwkk.",
    ".kwwwkkwwwk.",
    "kwwwwkkwwwkk",
    "kwwwwwwwwkkk",
    "kwwwwwkkkkkk",
    "kwwwkkkkkkkk",
    ".kwwkkwwkkk.",
    ".kwkkkwwkkk.",
    "..kkkkkkkk..",
    "....kkkk....",
  ],
  peace: [
    "....bbbb....",
    "..bb.bb.bb..",
    ".b...bb...b.",
    ".b...bb...b.",
    "b....bb....b",
    "b....bb....b",
    "b...bbbb...b",
    "b..bbbbbb..b",
    ".bbb.bb.bbb.",
    ".bb..bb..bb.",
    "..bb.bb.bb..",
    "....bbbb....",
  ],
  headphones: [
    "...kkkkkk...",
    "..kssssssk..",
    ".kskkkkkksk.",
    ".ksk....ksk.",
    ".ksk....ksk.",
    "kkkk....kkkk",
    "kvvk....kvvk",
    "kvvk....kvvk",
    "kvvk....kvvk",
    "kkkk....kkkk",
  ],
  flower: [
    "....kkk....",
    "...kpppk...",
    ".kkkpppkkk.",
    "kpppkykpppk",
    "kpppyyypppk",
    "kpppkykpppk",
    ".kkkpppkkk.",
    "...kpppk...",
    "....kkk....",
    ".....g.....",
    "...g.g.....",
    "....gg.....",
    ".....g.....",
  ],
  rainbow: [
    "...rrrrrrrr...",
    "..rroooooorr..",
    ".rrooyyyyoorr.",
    "rrooyyggyyoorr",
    "rooyyg..gyyoor",
    "rooyg....gyoor",
    "rooyg....gyoor",
  ],
  sparkle: [
    "....y....",
    "....y....",
    "...yyy...",
    "..yyyyy..",
    "yyyyyyyyy",
    "..yyyyy..",
    "...yyy...",
    "....y....",
    "....y....",
  ],
  smile: [
    ".VVVVVVVV.",
    "VVVVVVVVVV",
    "VVyVVVVyVV",
    "VVyVVVVyVV",
    "VVVVVVVVVV",
    "VyVVVVVVyV",
    "VVyyyyyyVV",
    "VVVVVVVVVV",
    "VVVVVVVVVV",
    ".VVVVVVVV.",
  ],
};

const PIXEL = 3; // one icon pixel, in CSS pixels
const CELL = 104; // the page is cut into squares this big; each may hold one icon
const CHANCE = 0.6; // share of squares that try for an icon (more on a phone, where room is scarce)
const TRIES = 12; // spots tried around a square before giving up on it
const GAP = 14; // least space between two icons, in CSS pixels
const FADE = 0.5;
const TILT = 0.26; // radians either way, about 15 degrees

const canvas = document.getElementById("backdrop");
const page = document.querySelector(".page");

/** Each icon painted once at its natural size, to be stamped onto the backdrop. */
const stamps = Object.values(ICONS).map((rows) => {
  const c = document.createElement("canvas");
  c.width = Math.max(...rows.map((r) => r.length));
  c.height = rows.length;
  const ctx = c.getContext("2d");
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (!COLOURS[ch]) return;
      ctx.fillStyle = COLOURS[ch];
      ctx.fillRect(x, y, 1, 1);
    }),
  );
  return c;
});

// The same square always gets the same icon, so resizing the window never reshuffles them.
function dice(col, row) {
  let a = (Math.imul(col + 1, 73856093) ^ Math.imul(row + 1, 19349663) ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let last = "";

export function drawBackdrop() {
  const w = document.documentElement.clientWidth;
  const h = Math.max(innerHeight, page ? page.offsetHeight : 0);
  const ratio = Math.min(2, devicePixelRatio || 1);
  // Icons only go where the page is empty: never under the words or the boxes.
  const keepClear = [...document.querySelectorAll(".masthead h1, .masthead .lede, .card")]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ left: r.left - 6, right: r.right + 6, top: r.top + scrollY - 6, bottom: r.bottom + scrollY + 6 }));
  const key = [w, h, ratio, ...keepClear.flatMap((r) => [r.left, r.right, r.top, r.bottom].map(Math.round))].join();
  if (key === last) return;
  last = key;

  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = FADE;

  const chance = w < 700 ? 0.95 : CHANCE;
  const spots = [];
  let placed = 0;
  for (let row = 0; row * CELL < h; row++) {
    for (let col = 0; col * CELL < w; col++) {
      const roll = dice(col, row);
      if (roll() > chance) continue;
      const stamp = stamps[(col * 3 + row * 7 + Math.floor(roll() * 3)) % stamps.length];
      const sw = stamp.width * PIXEL;
      const sh = stamp.height * PIXEL;
      const reach = Math.hypot(sw, sh) / 2; // room the icon needs once it is tilted
      const angle = (roll() * 2 - 1) * TILT;
      // Look around this square for a spot where the whole icon sits on empty page,
      // clear of the boxes, the words and the icons already placed.
      let cx, cy, fits = false;
      for (let t = 0; t < TRIES && !fits; t++) {
        cx = (col - 0.25 + roll() * 1.5) * CELL;
        cy = (row - 0.25 + roll() * 1.5) * CELL;
        fits =
          cx - reach >= 0 && cy - reach >= 0 && cx + reach <= w && cy + reach <= h &&
          !keepClear.some((r) => cx + reach > r.left && cx - reach < r.right && cy + reach > r.top && cy - reach < r.bottom) &&
          !spots.some((p) => Math.hypot(p.cx - cx, p.cy - cy) < p.reach + reach + GAP);
      }
      if (!fits) continue;
      spots.push({ cx, cy, reach });
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.drawImage(stamp, -sw / 2, -sh / 2, sw, sh);
      ctx.restore();
      placed++;
    }
  }
  globalThis.__backdrop = { placed, icons: stamps.length };
}

if (canvas) {
  let queued = false;
  const redraw = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      drawBackdrop();
    });
  };
  drawBackdrop();
  addEventListener("resize", redraw);
  // The page grows when the results appear; the backdrop grows with it.
  if (page && "ResizeObserver" in globalThis) new ResizeObserver(redraw).observe(page);
}

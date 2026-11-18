// Motions for a painted emoji.
//
// The model paints one still picture, so it cannot draw the frames of a real walk. These motions
// move the finished picture instead, one whole pixel at a time, the way old game sprites were
// animated. The motion is chosen from the words of the prompt: "Dudu walking" walks, "Tal
// running" runs. Each motion is a short loop of frames made from the 16 x 16 picture.
//
// The painted pictures fill their 16 x 16 square edge to edge, so moving one inside that square
// would cut off the top of a head. Frames are therefore 20 x 20, with the picture in the middle
// and two empty pixels all round for it to move into.

const G = 16; // the picture
export const PAD = 2;
export const FRAME = G + 2 * PAD; // a frame of the animation

const painted = (src, x, y) => x >= 0 && y >= 0 && x < G && y < G && src[(y * G + x) * 4 + 3] > 0;

/**
 * Build a frame by saying, for each spot, which pixel of the picture it shows. Spots are counted
 * from the picture's own corner, so they run from -2 to 17 and (0, 0) is where the picture's first
 * pixel normally sits.
 */
function remap(src, from) {
  const out = new Uint8ClampedArray(FRAME * FRAME * 4);
  for (let fy = 0; fy < FRAME; fy++) {
    for (let fx = 0; fx < FRAME; fx++) {
      const at = from(fx - PAD, fy - PAD);
      if (!at) continue;
      const [sx, sy] = at;
      if (sx < 0 || sy < 0 || sx >= G || sy >= G) continue;
      const s = (sy * G + sx) * 4;
      out.set(src.subarray(s, s + 4), (fy * FRAME + fx) * 4);
    }
  }
  return out;
}

/** The picture standing still in the middle of a frame. */
export const still = (src) => remap(src, (x, y) => [x, y]);

/**
 * Find a pair of legs. A full-body figure ends in two separate feet: its lowest rows each have a
 * gap in the middle. A head-and-shoulders picture ends in one solid row of shirt and has none.
 * Returns the first and last row of the legs and the column that separates left leg from right,
 * or null.
 */
export function findLegs(src) {
  const runsOf = (y) => {
    const runs = [];
    for (let x = 0; x < G; x++) {
      if (!painted(src, x, y)) continue;
      if (runs.length && runs[runs.length - 1][1] === x - 1) runs[runs.length - 1][1] = x;
      else runs.push([x, x]);
    }
    return runs;
  };
  let bottom = G - 1;
  while (bottom >= 0 && !runsOf(bottom).length) bottom--;
  if (bottom < 4) return null;
  const feet = runsOf(bottom);
  if (feet.length < 2) return null;
  // The widest gap in the lowest row is the space between the feet.
  let split = 0;
  let widest = 0;
  for (let i = 1; i < feet.length; i++) {
    const gap = feet[i][0] - feet[i - 1][1] - 1;
    if (gap > widest) {
      widest = gap;
      split = feet[i - 1][1] + 1 + Math.floor(gap / 2);
    }
  }
  // Legs reach up while that column stays empty, four rows at most.
  let top = bottom;
  while (top - 1 > bottom - 4 && !painted(src, split, top - 1) && runsOf(top - 1).length >= 2) top--;
  return { top, bottom, split };
}

/**
 * One pose of the picture.
 *   dx, dy    slide the whole picture
 *   lean      slide only the top `leanRows` rows sideways, so the head leads or sways
 *   stride    move the legs: 1 spreads them one pixel apart, -1 brings them together
 *   squash    press the top half down one row, as when landing
 */
function pose(src, { dx = 0, dy = 0, lean = 0, leanRows = 8, stride = 0, squash = false } = {}, legs = null) {
  return remap(src, (x, y) => {
    let sx = x - dx;
    let sy = y - dy;
    if (squash) {
      if (sy < 1) return null;
      if (sy < 8) sy -= 1;
    }
    if (stride && legs && sy >= legs.top && sy <= legs.bottom) {
      // The left leg moves by -stride and the right leg by +stride. Work out which one is here.
      const fromRight = sx - stride;
      const fromLeft = sx + stride;
      if (fromRight >= legs.split && painted(src, fromRight, sy)) return [fromRight, sy];
      if (fromLeft < legs.split && painted(src, fromLeft, sy)) return [fromLeft, sy];
      return null;
    }
    if (lean && sy < leanRows) sx -= lean;
    return [sx, sy];
  });
}

// Spin: the picture as a coin turning. Widths follow the cosine of 0, 30, 60 ... 330 degrees;
// between 90 and 270 degrees it is seen from behind, so it is mirrored.
const SPIN = [16, 14, 8, 2, 8, 14, 16, 14, 8, 2, 8, 14];

/** A motion made of poses: one list entry per frame. */
const posed = (list) => ({
  frames: list.length,
  draw: (src, i, legs) => pose(src, list[i], legs),
});

export const EFFECTS = [
  {
    id: "walk",
    label: "Walk",
    delayMs: 140,
    words: /\b(walk|walks|walking|stroll|strolling|march|marching|hike|hiking|stepping)\b/i,
    // Stand, step, stand, step. A step lifts the body a pixel, sways the head, and moves the legs.
    ...posed([{}, { dy: -1, lean: -1, stride: 1 }, {}, { dy: -1, lean: 1, stride: -1 }]),
  },
  {
    id: "run",
    label: "Run",
    delayMs: 70,
    words: /\b(run|runs|running|jog|jogs|jogging|sprint|sprints|sprinting|rush|rushing|hurry|hurrying|racing|chasing)\b/i,
    // Like a walk at twice the speed: leaning forward all the time and leaving the ground higher.
    ...posed([
      { lean: 1, leanRows: 6 },
      { lean: 1, leanRows: 6, dy: -2, stride: 1 },
      { lean: 1, leanRows: 6 },
      { lean: 1, leanRows: 6, dy: -2, stride: -1 },
    ]),
  },
  {
    id: "jump",
    label: "Jump",
    delayMs: 90,
    words: /\b(jump|jumps|jumping|hop|hops|hopping|bounce|bounces|bouncing|leap|leaping|excited|cheering)\b/i,
    // Squash on the ground, up two pixels, hang for a moment, and back down.
    ...posed([{ squash: true }, { dy: -1 }, { dy: -2 }, { dy: -2 }, { dy: -1 }, {}]),
  },
  {
    id: "dance",
    label: "Dance",
    delayMs: 110,
    words: /\b(dance|dances|dancing|party|partying|celebrate|celebrates|celebrating|groove|grooving|disco)\b/i,
    // Sway to one side with a little hop, back to the middle, then the other side.
    ...posed([{ lean: -1, dx: -1 }, { lean: -1, dx: -1, dy: -1 }, {}, { lean: 1, dx: 1 }, { lean: 1, dx: 1, dy: -1 }, {}]),
  },
  {
    id: "wave",
    label: "Wave",
    delayMs: 180,
    words: /\b(wave|waves|waving|hello|hi|hey|greeting|bye|goodbye)\b/i,
    // The model already paints the raised hand; the top of the picture tilts side to side.
    ...posed([{ lean: -1, leanRows: 6 }, {}, { lean: 1, leanRows: 6 }, {}]),
  },
  {
    id: "float",
    label: "Float",
    delayMs: 120,
    words: /\b(fly|flies|flying|float|floats|floating|hover|hovers|hovering|swim|swims|swimming)\b/i,
    // A slow drift up and down.
    ...posed([{}, { dy: -1 }, { dy: -2 }, { dy: -2 }, { dy: -1 }, {}, { dy: 1 }, { dy: 1 }]),
  },
  {
    id: "shake",
    label: "Shake",
    delayMs: 50,
    words: /\b(shake|shakes|shaking|angry|furious|laugh|laughs|laughing|scared|cold|shivering|cry|cries|crying|nervous|panic|vibrating)\b/i,
    ...posed([{ dx: -1 }, { dx: 1 }, { dy: 1 }, { dx: -1 }, { dx: 1, dy: -1 }, {}]),
  },
  {
    id: "spin",
    label: "Spin",
    delayMs: 80,
    words: /\b(spin|spins|spinning|dizzy|turning|rolling|twirl|twirls|twirling)\b/i,
    frames: SPIN.length,
    draw(src, i) {
      const w = SPIN[i];
      const mirrored = i >= 4 && i <= 8;
      const left = (G - w) / 2;
      return remap(src, (x, y) => {
        if (x < left || x >= left + w) return null;
        const sx = Math.floor(((x - left) * G) / w);
        return [mirrored ? G - 1 - sx : sx, y];
      });
    },
  },
];

/** The motion used when the prompt names none: a gentle drift suits a heart as well as a face. */
export const DEFAULT_EFFECT = "float";

export const effectById = (id) => EFFECTS.find((e) => e.id === id);

/** Every frame of a motion for one picture (RGBA, FRAME x FRAME). */
export function framesOf(effect, src) {
  const legs = findLegs(src);
  return Array.from({ length: effect.frames }, (_, i) => effect.draw(src, i, legs));
}

/**
 * The motion a prompt asks for: "Dudu walking" walks. When a prompt names two, the first one
 * mentioned wins. Returns the id of the default when it names none.
 */
export function effectFor(prompt) {
  let best = null;
  let at = Infinity;
  for (const e of EFFECTS) {
    const m = e.words.exec(prompt);
    if (m && m.index < at) {
      at = m.index;
      best = e;
    }
  }
  return (best ?? effectById(DEFAULT_EFFECT)).id;
}

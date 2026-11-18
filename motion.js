// Motion styles for a painted emoji.
//
// The model paints one still picture, so it cannot draw a real walk with moving legs. These
// styles move the finished picture instead, one whole pixel at a time, the way old game sprites
// were animated. Each style is a short loop of frames made from the 16 x 16 picture.
//
// The painted pictures fill their 16 x 16 square edge to edge, so moving one inside that square
// would cut off the top of a head. Frames are therefore 20 x 20, with the picture in the middle
// and two empty pixels all round for it to move into.

const G = 16; // the picture
export const PAD = 2;
export const FRAME = G + 2 * PAD; // a frame of the animation

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

/** Slide the whole picture. */
const slide = (src, dx, dy) => remap(src, (x, y) => [x - dx, y - dy]);

// Spin: the picture as a coin turning. Widths follow the cosine of 0, 30, 60 ... 330 degrees;
// between 90 and 270 degrees it is seen from behind, so it is mirrored.
const SPIN = [16, 14, 8, 2, 8, 14, 16, 14, 8, 2, 8, 14];

export const EFFECTS = [
  {
    id: "walk",
    label: "Walk",
    delayMs: 140,
    frames: 4,
    words: /\b(walk|walks|walking|run|runs|running|jogging|marching|strolling|hiking)\b/i,
    // A step: the body lifts one pixel and the head leans, left foot then right foot.
    draw(src, i) {
      if (i % 2 === 0) return still(src);
      const lean = i === 1 ? -1 : 1;
      return remap(src, (x, y) => {
        const sy = y + 1;
        return [sy < 8 ? x - lean : x, sy];
      });
    },
  },
  {
    id: "bounce",
    label: "Bounce",
    delayMs: 90,
    frames: 6,
    words: /\b(jump|jumps|jumping|bounce|bouncing|hop|hopping|happy|dance|dancing|excited|celebrating|party|cheering)\b/i,
    // Squash on the ground, then up two pixels, hang for a moment, and back down.
    draw(src, i) {
      if (i === 0) return remap(src, (x, y) => (y >= 8 ? [x, y] : y >= 1 ? [x, y - 1] : null));
      return slide(src, 0, [0, -1, -2, -2, -1, 0][i]);
    },
  },
  {
    id: "shake",
    label: "Shake",
    delayMs: 50,
    frames: 6,
    words: /\b(shake|shakes|shaking|angry|furious|laughing|scared|cold|shivering|crying|nervous|vibrating|panic)\b/i,
    draw(src, i) {
      const [dx, dy] = [[-1, 0], [1, 0], [0, 1], [-1, 0], [1, -1], [0, 0]][i];
      return slide(src, dx, dy);
    },
  },
  {
    id: "spin",
    label: "Spin",
    delayMs: 80,
    frames: SPIN.length,
    words: /\b(spin|spins|spinning|dizzy|turning|rolling|twirling)\b/i,
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

export const effectById = (id) => EFFECTS.find((e) => e.id === id);

/** Every frame of a style for one picture (RGBA, FRAME x FRAME). */
export function framesOf(effect, src) {
  return Array.from({ length: effect.frames }, (_, i) => effect.draw(src, i));
}

/** The style a prompt asks for: "Dudu walking" picks Walk. Bounce when the prompt doesn't say. */
export function effectFor(prompt) {
  return (EFFECTS.find((e) => e.words.test(prompt)) ?? effectById("bounce")).id;
}

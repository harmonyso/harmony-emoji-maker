// A small animated-GIF writer, enough for pixel-art emoji: one shared palette of up to 255
// colours plus "see-through", every frame the full picture, looping forever.

/** LZW-compress palette indexes the way GIF wants them. Returns bytes. */
function lzw(indexes, minCodeSize) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  let table = new Map();
  const out = [];
  let hold = 0;
  let bits = 0;
  const emit = (code) => {
    hold |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.push(hold & 255);
      hold >>>= 8;
      bits -= 8;
    }
  };

  emit(clear);
  let prefix = indexes[0];
  for (let i = 1; i < indexes.length; i++) {
    const k = indexes[i];
    const key = (prefix << 8) | k;
    const known = table.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    emit(prefix);
    if (next === 4096) {
      // The table is full: tell the reader to start over.
      emit(clear);
      next = end + 1;
      codeSize = minCodeSize + 1;
      table = new Map();
    } else {
      if (next >= 1 << codeSize) codeSize++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(end);
  if (bits > 0) out.push(hold & 255);
  return out;
}

/**
 * Write an animated GIF.
 * `frames` are RGBA pictures of `grid` x `grid` pixels; each pixel is drawn `scale` times as big.
 * Pixels with alpha below 128 are see-through. `delayMs` is how long each frame shows.
 */
export function encodeGif(frames, { grid, scale, delayMs }) {
  // One palette for all frames. Index 0 is "see-through".
  const palette = [[0, 0, 0]];
  const indexOf = new Map();
  const lookup = (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    let i = indexOf.get(key);
    if (i !== undefined) return i;
    if (palette.length < 256) {
      i = palette.length;
      palette.push([r, g, b]);
    } else {
      // More colours than a GIF can hold: use the closest one already in the palette.
      let best = Infinity;
      for (let p = 1; p < 256; p++) {
        const d = (palette[p][0] - r) ** 2 + (palette[p][1] - g) ** 2 + (palette[p][2] - b) ** 2;
        if (d < best) {
          best = d;
          i = p;
        }
      }
    }
    indexOf.set(key, i);
    return i;
  };

  const size = grid * scale;
  const pictures = frames.map((px) => {
    const small = new Uint8Array(grid * grid);
    for (let i = 0; i < small.length; i++) {
      small[i] = px[i * 4 + 3] < 128 ? 0 : lookup(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
    }
    const big = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      const row = Math.floor(y / scale) * grid;
      for (let x = 0; x < size; x++) big[y * size + x] = small[row + Math.floor(x / scale)];
    }
    return big;
  });

  let bitsPerPixel = 2;
  while (1 << bitsPerPixel < palette.length) bitsPerPixel++;
  const out = [];
  const word = (n) => out.push(n & 255, (n >> 8) & 255);

  out.push(...[..."GIF89a"].map((c) => c.charCodeAt(0)));
  word(size);
  word(size);
  out.push(0x80 | 0x70 | (bitsPerPixel - 1), 0, 0); // shared palette, its size; background 0; square pixels
  for (let i = 0; i < 1 << bitsPerPixel; i++) out.push(...(palette[i] ?? [0, 0, 0]));
  out.push(0x21, 0xff, 11, ...[..."NETSCAPE2.0"].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0); // loop forever

  const delay = Math.max(2, Math.round(delayMs / 10)); // hundredths of a second
  for (const big of pictures) {
    out.push(0x21, 0xf9, 4, (2 << 2) | 1); // clear the picture before the next frame; index 0 is see-through
    word(delay);
    out.push(0, 0);
    out.push(0x2c);
    word(0);
    word(0);
    word(size);
    word(size);
    out.push(0);
    out.push(bitsPerPixel);
    const data = lzw(big, bitsPerPixel);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      out.push(chunk.length, ...chunk);
    }
    out.push(0);
  }
  out.push(0x3b);
  return new Uint8Array(out);
}

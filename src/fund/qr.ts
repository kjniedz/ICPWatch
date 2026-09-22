// Minimal self-contained QR Code encoder (ISO/IEC 18004): byte mode, error correction level M,
// versions 1 to 10 (up to 213 bytes), all eight masks with the standard penalty scoring.
// Written for ICPWatch, no dependencies, no network. Output is a boolean matrix or an inline SVG string,
// so deposit addresses render server-side without any third party seeing them.
// Verified module-for-module against the reference `qrcode` npm package in test/fund.test.ts fixtures.

const EC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]; // level M, index = version
const NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
export const QR_MAX_VERSION = 10;

/** Number of data + error correction codewords for a version (function patterns and format bits excluded). */
function totalCodewords(ver: number): number {
  let bits = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    bits -= (25 * n - 10) * n - 55;
    if (ver >= 7) bits -= 36;
  }
  return Math.floor(bits / 8);
}

const dataCodewords = (ver: number) => totalCodewords(ver) - EC_PER_BLOCK[ver]! * NUM_BLOCKS[ver]!;

/** Payload capacity in bytes for a version at level M. */
export const qrCapacity = (ver: number) => Math.floor((dataCodewords(ver) * 8 - 4 - (ver < 10 ? 8 : 16)) / 8);

// ---- Reed-Solomon over GF(2^8), primitive polynomial 0x11D ---------------------------------------------

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): Uint8Array {
  const out = new Uint8Array(degree);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j]!, root);
      if (j + 1 < degree) out[j] = out[j]! ^ out[j + 1]!;
    }
    root = gfMul(root, 2);
  }
  return out;
}

function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const out = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ out[0]!;
    out.copyWithin(0, 1);
    out[out.length - 1] = 0;
    for (let i = 0; i < out.length; i++) out[i] = out[i]! ^ gfMul(divisor[i]!, factor);
  }
  return out;
}

// ---- encoder ---------------------------------------------------------------------------------------------

export interface QrCode { version: number; size: number; mask: number; modules: boolean[][] }

export function qrEncode(text: string | Uint8Array, opts: { mask?: number; minVersion?: number } = {}): QrCode {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  let ver = Math.max(1, opts.minVersion ?? 1);
  while (ver <= QR_MAX_VERSION && qrCapacity(ver) < bytes.length) ver++;
  if (ver > QR_MAX_VERSION) throw new Error(`QR payload too long: ${bytes.length} bytes, the limit is ${qrCapacity(QR_MAX_VERSION)}`);

  // Bit stream: mode 0100, length, payload, terminator, byte alignment, pad bytes.
  const capBits = dataCodewords(ver) * 8;
  const bits: number[] = [];
  const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = new Uint8Array(capBits / 8);
  bits.forEach((b, i) => { data[i >>> 3] = data[i >>> 3]! | (b << (7 - (i & 7))); });

  // Split into blocks, append error correction, interleave.
  const nb = NUM_BLOCKS[ver]!;
  const ecLen = EC_PER_BLOCK[ver]!;
  const total = totalCodewords(ver);
  const shortLen = Math.floor(total / nb) - ecLen;
  const numShort = nb - (total % nb);
  const divisor = rsDivisor(ecLen);
  const blocks: { d: Uint8Array; e: Uint8Array }[] = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const len = shortLen + (i < numShort ? 0 : 1);
    const d = data.subarray(k, k + len);
    k += len;
    blocks.push({ d, e: rsRemainder(d, divisor) });
  }
  const all: number[] = [];
  for (let i = 0; i <= shortLen; i++) for (const b of blocks) if (i < b.d.length) all.push(b.d[i]!);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) all.push(b.e[i]!);

  // Function patterns.
  const size = ver * 4 + 17;
  const m: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    m[y]![x] = dark;
    fn[y]![x] = true;
  };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
    }
  }
  const al = ALIGN[ver]!;
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i]! + dx, al[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = (mask: number) => {
    const d = (0b00 << 3) | mask; // level M = 00
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((d << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((f >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0); // reserves the format area before data placement
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((v >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark); set(b, a, dark);
    }
  }

  // Zigzag data placement.
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!fn[y]![x] && k < all.length * 8) { m[y]![x] = ((all[k >>> 3]! >>> (7 - (k & 7))) & 1) !== 0; k++; }
    }
  }

  const MASKS: ((x: number, y: number) => boolean)[] = [
    (x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (mask: number) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y]![x] && MASKS[mask]!(x, y)) m[y]![x] = !m[y]![x]; };

  let best = opts.mask ?? -1;
  if (best < 0 || best > 7) {
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(mask); drawFormat(mask);
      const s = penalty(m);
      if (s < bestScore) { bestScore = s; best = mask; }
      applyMask(mask); // XOR again: undo
    }
  }
  applyMask(best); drawFormat(best);
  return { version: ver, size, mask: best, modules: m };
}

function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    let hist = 0; // last 11 modules as bits, for the finder-like pattern 1011101 with 4 light modules on one side
    for (let i = 0; i < n; i++) {
      const v = get(i);
      if (i > 0 && v === get(i - 1)) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1;
      hist = ((hist << 1) | (v ? 1 : 0)) & 0x7ff;
      if (i >= 10 && (hist === 0b10111010000 || hist === 0b00001011101)) score += 40;
    }
  };
  let dark = 0;
  for (let y = 0; y < n; y++) {
    line((i) => m[y]![i]!);
    line((i) => m[i]![y]!);
    for (let x = 0; x < n; x++) {
      if (m[y]![x]) dark++;
      if (x + 1 < n && y + 1 < n && m[y]![x] === m[y]![x + 1] && m[y]![x] === m[y + 1]![x] && m[y]![x] === m[y + 1]![x + 1]) score += 3;
    }
  }
  score += Math.floor(Math.abs((dark * 20) / (n * n) - 10)) * 10;
  return score;
}

/**
 * Inline SVG, always dark on white with a 4 module quiet zone (scanners need the contrast whatever the site theme).
 * The text is never placed in the markup except through `title`, which is escaped.
 */
export function qrSvg(text: string, opts: { title?: string; px?: number } = {}): string {
  const q = qrEncode(text);
  const quiet = 4;
  const dim = q.size + quiet * 2;
  let d = "";
  for (let y = 0; y < q.size; y++) {
    for (let x = 0; x < q.size; x++) {
      if (!q.modules[y]![x]) continue;
      let w = 1;
      while (x + w < q.size && q.modules[y]![x + w]) w++;
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
      x += w - 1;
    }
  }
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const px = opts.px ?? 184;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${px}" height="${px}" role="img" shape-rendering="crispEdges"${opts.title ? ` aria-label="${esc(opts.title)}"` : ""}><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

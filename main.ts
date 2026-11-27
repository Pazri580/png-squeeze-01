// pazri png squeeze — a lossless PNG recompressor for 1280x720 RGBA screenshots.
//
// Strategy: shrink the picture before the deflate ever sees it, then pick the
// cheapest way to write what is left.
//   1. Colour-type reduction: a palette (type 3) when the picture holds at most
//      256 colours, grey (type 0) when every pixel is grey, grey+alpha (type 4)
//      or RGB (type 2) with a tRNS key when one fully transparent value covers
//      every non-opaque pixel, RGBA (type 6) otherwise.
//   2. Filter search: every row may take its own filter. Candidates are the
//      fixed filters 0, 1, 2 and 4, the minimum-sum heuristic (PNG spec 12.8),
//      and a brute-force pass that weighs each row's five filters by actually
//      deflating the row against the 32 KiB written before it. Each candidate
//      is weighed by zlib level 6; the smallest wins.
//   3. Deflate: the winner is written with an optimal-parse encoder of my
//      own (greedy lazy LZ77 with hash chains, optimal Huffman lengths), and
//      with zlib level 9; the smaller stream wins.
//
// Deterministic: no clock, no environment, no randomness — every limit is a
// fixed count, so two runs on the same set write the same bytes.
//
// Local run on the practice set (from the kit directory):
//   MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------------------
// PNG container: CRC-32, chunk assembly, decoding, IHDR.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const asciiBytes = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function assemblePng(chunks) {
  let size = 8;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(asciiBytes(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrData(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8; // bit depth
  d[9] = colourType;
  return d;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paethPredict(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Decode any PNG the contest reads (bit depth 8, no interlace) to RGBA.
function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = 6;
  let palette = null;
  let trns = null;
  const idatParts = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      colourType = data[9];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts));
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (filter === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (filter === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paethPredict(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s];
      rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i] * 3;
      rgba[d] = palette[e];
      rgba[d + 1] = palette[e + 1];
      rgba[d + 2] = palette[e + 2];
      rgba[d + 3] = trns !== null && samples[i] < trns.length ? trns[samples[i]] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Analysis: what the picture holds, in one pass.
// ---------------------------------------------------------------------------

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const words = rgba.byteOffset % 4 === 0 ? new Uint32Array(rgba.buffer, rgba.byteOffset, n) : null;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = words !== null ? words[i] : (rgba[d] | (rgba[d + 1] << 8) | (rgba[d + 2] << 16) | (rgba[d + 3] << 24));
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else {
        counts.set(c, k + 1);
      }
    }
  }
  const colours = many
    ? null
    : [...counts.keys()].map((c) => {
        const b = new Uint8Array(Uint32Array.of(c).buffer);
        return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
      });
  return { opaque, grey, colours };
}

// The one fully transparent value (grey or RGB) the picture may key by tRNS:
// every pixel is opaque or that exact value at alpha 0, and no opaque pixel
// carries the same value. Null when there is none.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

// ---------------------------------------------------------------------------
// Forms: the colour types an image can be written in, losslessly.
// ---------------------------------------------------------------------------

function paletteOrder(colours, order) {
  const luminance = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return luminance(x) - luminance(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const words = rgba.byteOffset % 4 === 0 ? new Uint32Array(rgba.buffer, rgba.byteOffset, n) : null;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const c = words !== null ? words[i] : (rgba[d] | (rgba[d + 1] << 8) | (rgba[d + 2] << 16) | (rgba[d + 3] << 24));
    indices[i] = index.get(c);
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

function channelSamples(rgba, colourType) {
  const n = rgba.length >>> 2;
  if (colourType === 6) return rgba;
  const ch = colourType === 0 ? 1 : colourType === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (colourType === 0) {
      out[s] = rgba[d];
    } else if (colourType === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let colourType;
  let trns = null;
  if (grey) {
    colourType = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    colourType = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  forms.push({
    colourType,
    bpp: { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType],
    samples: channelSamples(rgba, colourType),
    plte: null,
    trns,
  });
  return forms;
}

function chunkOverhead(form) {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

// ---------------------------------------------------------------------------
// Filters: the five PNG row filters, the minimum-sum choice, brute force.
// ---------------------------------------------------------------------------

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paethPredict(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

// Filter every row with one fixed filter, or with the minimum-sum choice.
function filterImage(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
    } else {
      let best = Infinity;
      let type = 0;
      for (let t = 0; t < 5; t++) {
        filterRow(t, cur, prev, bpp, trial[t]);
        const s = signedSum(trial[t]);
        if (s < best) {
          best = s;
          type = t;
        }
      }
      raw[at] = type;
      raw.set(trial[type], at + 1);
    }
  }
  return raw;
}

// Brute force: each row takes the filter whose deflated bytes are fewest,
// the row deflated at level 4 against the 32 KiB written before it.
function filterBrute(samples, width, height, bpp) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => {
    const row = new Uint8Array(stride + 1);
    return row;
  });
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let best = Infinity;
    let type = 0;
    for (let t = 0; t < 5; t++) {
      trial[t][0] = t;
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      const options = before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before };
      const len = deflateSync(trial[t], options).length;
      if (len < best) {
        best = len;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Deflate: an optimal-parse encoder in the manner of zopfli, written from
// scratch. A greedy lazy LZ77 parse with hash chains gives the first
// frequencies; Huffman lengths are built from them (capped at 15 bits the way
// zlib's gen_bitlen caps them); the block is then re-parsed by dynamic
// programming, which picks the cheapest literal/match cut at every position,
// and the lengths are rebuilt. The winner is emitted as a dynamic-Huffman
// block. Everything is bounded by fixed counts, never by the clock.
// ---------------------------------------------------------------------------

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lenSymbol(len) {
  let lo = 0, hi = 28;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEN_BASE[mid] <= len) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function distSymbol(dist) {
  let lo = 0, hi = 29;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= dist) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function huffmanLengths(freqs, maxBits) {
  const n = freqs.length;
  const lengths = new Array(n).fill(0);
  const alive = [];
  for (let i = 0; i < n; i++) if (freqs[i] > 0) alive.push(i);
  if (alive.length === 0) return lengths;
  if (alive.length === 1) {
    lengths[alive[0]] = 1;
    return lengths;
  }
  const weight = freqs.slice();
  const parent = new Array(2 * n).fill(-1);
  const pool = alive.slice();
  let next = n;
  while (pool.length > 1) {
    let a = -1, b = -1;
    for (const x of pool) {
      if (a === -1 || weight[x] < weight[a]) { b = a; a = x; }
      else if (b === -1 || weight[x] < weight[b]) { b = x; }
    }
    pool.splice(pool.indexOf(a), 1);
    pool.splice(pool.indexOf(b), 1);
    weight[next] = weight[a] + weight[b];
    parent[a] = next;
    parent[b] = next;
    pool.push(next);
    next++;
  }
  for (const leaf of alive) {
    let d = 0, x = leaf;
    while (parent[x] !== -1) { d++; x = parent[x]; }
    lengths[leaf] = d;
  }
  const blCount = new Array(maxBits + 1).fill(0);
  let overflow = 0;
  for (const s of alive) {
    const l = lengths[s];
    if (l > maxBits) { blCount[maxBits]++; overflow++; }
    else blCount[l]++;
  }
  if (overflow > 0) {
    while (overflow > 0) {
      let bits = maxBits - 1;
      while (bits > 0 && blCount[bits] === 0) bits--;
      if (bits === 0 || blCount[maxBits] === 0) break;
      blCount[bits]--;
      blCount[bits + 1] += 2;
      blCount[maxBits]--;
      overflow -= 2;
    }
    const order = alive.slice().sort((a, b) => freqs[a] - freqs[b] || a - b);
    let idx = 0;
    for (let b = maxBits; b >= 1; b--) {
      for (let k = 0; k < blCount[b] && idx < order.length; k++) lengths[order[idx++]] = b;
    }
  }
  return lengths;
}

function canonicalCodes(lengths) {
  const maxBits = Math.max(0, ...lengths);
  const blCount = new Array(maxBits + 1).fill(0);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Array(maxBits + 1).fill(0);
  let code = 0;
  for (let b = 1; b <= maxBits; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  const codes = new Array(lengths.length).fill(0);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (l > 0) {
      let c = nextCode[l]++;
      let r = 0;
      for (let i = 0; i < l; i++) {
        r = (r << 1) | (c & 1);
        c >>= 1;
      }
      codes[s] = r;
    }
  }
  return { codes, lengths };
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.bitbuf = 0;
    this.bitcnt = 0;
  }
  write(value, count) {
    this.bitbuf |= (value << this.bitcnt) >>> 0;
    this.bitcnt += count;
    while (this.bitcnt >= 8) {
      this.bytes.push(this.bitbuf & 0xff);
      this.bitbuf >>>= 8;
      this.bitcnt -= 8;
    }
  }
  finish() {
    if (this.bitcnt > 0) this.bytes.push(this.bitbuf & 0xff);
    return new Uint8Array(this.bytes);
  }
}

const HASH_SIZE = 1 << 15;
const HASH_MASK = HASH_SIZE - 1;
const CHAIN_LIMIT = 4096;
const MAX_MATCH = 258;
const MIN_MATCH = 3;
const MAX_DIST = 32768;
const DEFLATE_BLOCK = 262144;

function makeMatcher(data) {
  const n = data.length;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const hashAt = (i) => {
    const v = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    return (Math.imul(v, 0x9e3779b1) >>> 17) & HASH_MASK;
  };
  return {
    insert(i) {
      if (i + 2 >= n) return;
      const h = hashAt(i);
      prev[i] = head[h];
      head[h] = i;
    },
    longest(i, maxLen) {
      if (i + 2 >= n) return [0, 0];
      const h = hashAt(i);
      let bestLen = 0, bestDist = 0;
      let cand = head[h];
      let steps = 0;
      const limit = Math.min(maxLen, n - i);
      while (cand !== -1 && steps < CHAIN_LIMIT) {
        const dist = i - cand;
        if (dist > MAX_DIST) break;
        if (data[cand] === data[i] && (bestLen === 0 || data[cand + bestLen] === data[i + bestLen])) {
          let len = 0;
          while (len < limit && data[cand + len] === data[i + len]) len++;
          if (len > bestLen) {
            bestLen = len;
            bestDist = dist;
            if (len >= limit) break;
          }
        }
        cand = prev[cand];
        steps++;
      }
      return [bestLen, bestDist];
    },
  };
}

// Greedy lazy LZ77 parse of one block: at each position take the longest
// match unless the next position's match is longer, else a literal.
function parseGreedy(data, start, end, matcher) {
  const ops = [];
  const litFreq = new Array(288).fill(0);
  const distFreq = new Array(30).fill(0);
  let i = start;
  while (i < end) {
    const maxLen = Math.min(MAX_MATCH, end - i);
    let len = 0, dist = 0;
    if (maxLen >= MIN_MATCH) [len, dist] = matcher.longest(i, maxLen);
    if (len >= MIN_MATCH && i + 1 < end && maxLen - 1 >= MIN_MATCH) {
      const [len2] = matcher.longest(i + 1, maxLen - 1);
      if (len2 > len) len = 0;
    }
    if (len >= MIN_MATCH) {
      litFreq[257 + lenSymbol(len)]++;
      distFreq[distSymbol(dist)]++;
      ops.push({ len, dist });
      matcher.insert(i);
      for (let k = 1; k < len; k++) matcher.insert(i + k);
      i += len;
    } else {
      litFreq[data[i]]++;
      ops.push({ lit: data[i] });
      matcher.insert(i);
      i++;
    }
  }
  litFreq[256]++;
  return { ops, litFreq, distFreq };
}

function rleLengths(lengths) {
  const out = [];
  let i = 0;
  while (i < lengths.length) {
    const v = lengths[i];
    let run = 1;
    while (i + run < lengths.length && lengths[i + run] === v) run++;
    const total = run;
    if (v === 0) {
      while (run >= 11) {
        const take = Math.min(run, 138);
        out.push([18, take - 11, 7]);
        run -= take;
      }
      if (run >= 3) {
        out.push([17, run - 3, 3]);
        run = 0;
      }
      while (run > 0) {
        out.push([0, 0, 0]);
        run--;
      }
    } else {
      out.push([v, 0, 0]);
      run--;
      while (run >= 3) {
        const take = Math.min(run, 6);
        out.push([16, take - 3, 2]);
        run -= take;
      }
      while (run > 0) {
        out.push([v, 0, 0]);
        run--;
      }
    }
    i += total;
  }
  return out;
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function emitBlock(bw, ops, litLengths, distLengths, isLast) {
  bw.write(isLast ? 1 : 0, 1);
  bw.write(2, 2);
  let hlit = 286;
  while (hlit > 257 && litLengths[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLengths[hdist - 1] === 0) hdist--;
  const all = litLengths.slice(0, hlit).concat(distLengths.slice(0, hdist));
  const rle = rleLengths(all);
  const clFreq = new Array(19).fill(0);
  for (const [s] of rle) clFreq[s]++;
  const clLengths = huffmanLengths(clFreq, 7);
  const clCode = canonicalCodes(clLengths);
  let hclen = 19;
  while (hclen > 4 && clLengths[CL_ORDER[hclen - 1]] === 0) hclen--;
  bw.write(hlit - 257, 5);
  bw.write(hdist - 1, 5);
  bw.write(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) bw.write(clLengths[CL_ORDER[k]], 3);
  for (const [s, extra, bits] of rle) {
    bw.write(clCode.codes[s], clLengths[s]);
    if (bits) bw.write(extra, bits);
  }
  const litCode = canonicalCodes(litLengths);
  const distCode = canonicalCodes(distLengths);
  for (const op of ops) {
    if (op.lit !== undefined) {
      bw.write(litCode.codes[op.lit], litLengths[op.lit]);
    } else {
      const ls = lenSymbol(op.len);
      bw.write(litCode.codes[257 + ls], litLengths[257 + ls]);
      if (LEN_EXTRA[ls]) bw.write(op.len - LEN_BASE[ls], LEN_EXTRA[ls]);
      const ds = distSymbol(op.dist);
      bw.write(distCode.codes[ds], distLengths[ds]);
      if (DIST_EXTRA[ds]) bw.write(op.dist - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  bw.write(litCode.codes[256], litLengths[256]);
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// The zlib stream of `data` from the greedy parse, in blocks of DEFLATE_BLOCK.
function deflateGreedy(data) {
  if (data.length === 0) {
    const out = new Uint8Array(11);
    out[0] = 0x78; out[1] = 0x01; out[2] = 0x01; out[3] = 0; out[4] = 0; out[5] = 0xff; out[6] = 0xff;
    new DataView(out.buffer).setUint32(7, 1);
    return out;
  }
  const bw = new BitWriter();
  const n = data.length;
  let pos = 0;
  while (pos < n) {
    const end = Math.min(n, pos + DEFLATE_BLOCK);
    const matcher = makeMatcher(data);
    for (let p = Math.max(0, pos - MAX_DIST); p < pos; p++) matcher.insert(p);
    const parsed = parseGreedy(data, pos, end, matcher);
    let litLen = huffmanLengths(parsed.litFreq, 15);
    let distLen;
    if (parsed.distFreq.every((f) => f === 0)) {
      const d = new Array(30).fill(0);
      d[0] = 1;
      distLen = huffmanLengths(d, 15);
    } else {
      distLen = huffmanLengths(parsed.distFreq, 15);
    }
    emitBlock(bw, parsed.ops, litLen, distLen, end === n);
    pos = end;
  }
  const body = bw.finish();
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(body, 2);
  new DataView(out.buffer).setUint32(2 + body.length, adler32(data));
  return out;
}

// ---------------------------------------------------------------------------
// Compression of one picture: screen every form and filter, keep the winner.
// ---------------------------------------------------------------------------

const SCREEN_LEVEL = 6;

function compressImage(rgba, width, height) {
  const forms = formsOf(rgba);
  let best = null;
  for (const form of forms) {
    const overhead = chunkOverhead(form);
    const choices = [0, 1, 2, 4, 'minsum'];
    for (const choice of choices) {
      const data = filterImage(form.samples, width, height, form.bpp, choice);
      const size = deflateSync(data, { level: SCREEN_LEVEL }).length + overhead;
      if (best === null || size < best.size) best = { form, data, size };
    }
    const bruteData = filterBrute(form.samples, width, height, form.bpp);
    const bruteSize = deflateSync(bruteData, { level: SCREEN_LEVEL }).length + overhead;
    if (bruteSize < best.size) best = { form, data: bruteData, size: bruteSize };
  }
  const z9 = deflateSync(best.data, { level: 9 });
  const mine = deflateGreedy(best.data);
  const idat = mine.length <= z9.length ? mine : z9;
  const chunks = [['IHDR', ihdrData(width, height, best.form.colourType)]];
  if (best.form.plte !== null) chunks.push(['PLTE', best.form.plte]);
  if (best.form.trns !== null) chunks.push(['tRNS', best.form.trns]);
  chunks.push(['IDAT', new Uint8Array(idat)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return assemblePng(chunks);
}

// ---------------------------------------------------------------------------
// Main: every instance of the set, in order.
// ---------------------------------------------------------------------------

for (const id of readdirSync(INPUT_DIR).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), compressImage(image.rgba, image.width, image.height));
}

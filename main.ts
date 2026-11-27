// png-squeeze: squeeze 1280x720 screenshots into the smallest lossless PNG.
// Node 22, standard library only, no dependencies, no network, no clock reads.
// Strategy: pick the best colour form (palette / grey / grey+alpha / RGB / RGBA / tRNS key),
// pick the best fixed filter per image (plus a per-row fewest-pairs choice) by real zlib cost,
// then re-encode the winner with a zopfli-style deflate: DP-lite optimal parsing over two
// candidate matches per position (longest overall + longest near), structural-distance matches
// (byte run / pixel repeat / row repeat), per-block dynamic Huffman with package-merge
// length-limited codes, and block splitting aligned to image rows. Deterministic: the work
// budget is fixed by the data, never by the wall clock.
import { inflateSync, deflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- PNG basics
const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Decode a PNG the contest reads (8-bit, non-interlaced, colour types 0/2/3/4/6) to RGBA.
function decodePng(bytes) {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('bad PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null, palette = null, trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(type + ' CRC');
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], interlace: data[12] };
      if (header.depth !== 8 || header.interlace !== 0) throw new Error('unsupported IHDR');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    else throw new Error('unexpected chunk ' + type);
  }
  if (!ended || idat.length === 0 || !header) throw new Error('incomplete PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('inflated size mismatch');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride, p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) { for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0); }
    else if (ft === 2) { for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0); }
    else if (ft === 3) { for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1); }
    else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else throw new Error('bad filter ' + ft);
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = lut[e * 4]; rgba[d + 1] = lut[e * 4 + 1]; rgba[d + 2] = lut[e * 4 + 2]; rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- colour forms
function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true, grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}

// The one fully transparent value the image may key by tRNS instead of an alpha channel.
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

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0]; plte[i * 3 + 1] = c.rgba[1]; plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

// The forms an image can take, each {colourType, bpp, samples, plte, trns, filters}.
// A palette holds a <=256-colour image in a third of the bytes of RGB, so its RGB/RGBA form
// is not tried; a grey image's palette form never beats its grey form (same 1 byte a pixel
// plus the PLTE chunk, and grey values keep their ordering for the filters), so it is skipped.
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null && !grey) {
    for (const [order, filters] of [['count', [0]], ['luminance', [0, 2, 4, 'pairs']]]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    return forms;
  }
  // Grey with <=256 colours takes the grey form only (see above): fall through.
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct, trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: [0, 2, 4, 'pairs'] });
  return forms;
}

const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// ---------------------------------------------------------------- filtering
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) { for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0); }
  else if (type === 2) { for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]); }
  else if (type === 3) { for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1); }
  else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

// The five filtered variants of an image (one buffer each), plus the per-row
// fewest-distinct-byte-pairs choice built from them.
function filteredVariants(samples, width, height, bpp) {
  const stride = width * bpp;
  const size = height * (stride + 1);
  const variants = [];
  for (let t = 0; t < 5; t++) variants.push(new Uint8Array(size));
  const seen = new Uint32Array(65536);
  const pairs = new Uint8Array(size);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    for (let t = 0; t < 5; t++) {
      variants[t][at] = t;
      filterRow(t, cur, prev, bpp, variants[t].subarray(at + 1, at + 1 + stride));
    }
    // fewest distinct byte pairs
    let bestT = 0, bestN = Infinity;
    for (let t = 0; t < 5; t++) {
      const row = variants[t].subarray(at + 1, at + 1 + stride);
      stamp++;
      let n = 0;
      for (let i = 1; i < row.length; i++) {
        const pair = (row[i - 1] << 8) | row[i];
        if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
      }
      if (n < bestN) { bestN = n; bestT = t; }
    }
    pairs[at] = bestT;
    pairs.set(variants[bestT].subarray(at + 1, at + 1 + stride), at + 1);
  }
  return { variants, pairs };
}

// ---------------------------------------------------------------- zopfli-style deflate
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lengthSymbol(len) {
  let lo = 0, hi = 28;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (LENGTH_BASE[mid] <= len) lo = mid; else hi = mid - 1; }
  return lo;
}
function distSymbol(d) {
  let lo = 0, hi = 29;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (DIST_BASE[mid] <= d) lo = mid; else hi = mid - 1; }
  return lo;
}

const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
function hash3(d, i) {
  let h = (d[i] * 0x9e3779b1) ^ (d[i + 1] * 0x85ebca6b) ^ (d[i + 2] * 0xc2b2ae35);
  h ^= h >>> 13;
  return h & HASH_MASK;
}

// Package-merge length-limited Huffman code lengths (max 15 bits).
function codeLengths(freq, maxBits = 15) {
  const nSym = freq.length;
  const lengths = new Uint8Array(nSym);
  const syms = [];
  for (let s = 0; s < nSym; s++) if (freq[s] > 0) syms.push(s);
  const n = syms.length;
  if (n === 0) return lengths;
  if (n === 1) { lengths[syms[0]] = 1; return lengths; }
  const base = syms.map((s) => ({ f: freq[s], members: [s] })).sort((a, b) => a.f - b.f);
  const lists = [base];
  for (let level = 1; level < maxBits; level++) {
    const prev = lists[level - 1];
    const packaged = [];
    for (let i = 0; i + 1 < prev.length; i += 2) {
      packaged.push({ f: prev[i].f + prev[i + 1].f, members: prev[i].members.concat(prev[i + 1].members) });
    }
    if (prev.length % 2 === 1) packaged.push(prev[prev.length - 1]);
    const merged = [];
    let a = 0, b = 0;
    const limit = 2 * n - 2;
    while (merged.length < limit && (a < packaged.length || b < base.length)) {
      if (b >= base.length || (a < packaged.length && packaged[a].f <= base[b].f)) merged.push(packaged[a++]);
      else merged.push(base[b++]);
    }
    lists.push(merged);
  }
  const counts = new Map();
  for (const item of lists[maxBits - 1]) for (const s of item.members) counts.set(s, (counts.get(s) || 0) + 1);
  for (const [s, c] of counts) lengths[s] = c;
  return lengths;
}

// Canonical Huffman codes from lengths; codes are bit-reversed for LSB-first writing.
function canonicalCodes(lengths) {
  const n = lengths.length;
  const codes = new Uint32Array(n);
  let maxLen = 0;
  for (let i = 0; i < n; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
  const blCount = new Uint32Array(maxLen + 1);
  for (let i = 0; i < n; i++) if (lengths[i] > 0) blCount[lengths[i]]++;
  const nextCode = new Uint32Array(maxLen + 1);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) { code = (code + blCount[bits - 1]) << 1; nextCode[bits] = code; }
  for (let s = 0; s < n; s++) {
    const len = lengths[s];
    if (len === 0) continue;
    let c = nextCode[len]++;
    let rev = 0;
    for (let i = 0; i < len; i++) { rev = (rev << 1) | ((c >> i) & 1); }
    codes[s] = rev;
  }
  return { codes, lengths };
}

class BitWriter {
  constructor(cap) { this.buf = new Uint8Array(cap); this.pos = 0; this.bitbuf = 0; this.bitcnt = 0; }
  write(value, count) {
    this.bitbuf |= (value & ((1 << count) - 1)) << this.bitcnt;
    this.bitcnt += count;
    while (this.bitcnt >= 8) { this.buf[this.pos++] = this.bitbuf & 0xff; this.bitbuf >>>= 8; this.bitcnt -= 8; }
  }
  align() { if (this.bitcnt > 0) { this.buf[this.pos++] = this.bitbuf & 0xff; this.bitbuf = 0; this.bitcnt = 0; } }
}

const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function fixedLitLen() {
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 0; i < 8; i++) l[280 + i] = 8;
  return l;
}
const FIXED_DIST_LEN = new Uint8Array(32).fill(5);

// DP-lite optimal parsing. Per position the DP considers the literal, the longest match
// overall and the longest match at a near distance (<=512: horizontal runs), plus matches at
// structural distances (byte run / pixel repeat / row repeat) that a hash chain's early exit
// would otherwise miss. Costs are per-block, matching the code lengths actually emitted.
const NEAR_DIST = 512;
function parseDP(data, litCosts, lenCosts, distCosts, maxChain, blockOf, goodLen, structDists) {
  const n = data.length;
  const cost = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) cost[i] = Infinity;
  const chLen = new Uint16Array(n + 1);
  const chDist = new Int32Array(n + 1);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n);
  const maxLenAll = 258;
  const nStruct = structDists ? structDists.length : 0;
  for (let i = 0; i < n; i++) {
    const ci = cost[i];
    const b = blockOf(i);
    const litCost = litCosts[b], lenCost = lenCosts[b], distCost = distCosts[b];
    const lc = ci + litCost[data[i]];
    if (lc < cost[i + 1]) { cost[i + 1] = lc; chLen[i + 1] = 0; chDist[i + 1] = 0; }
    if (i + 3 <= n) {
      const h = hash3(data, i);
      let cand = head[h];
      let bestLen = 2, bestDist = 0;
      let nearLen = 2, nearDist = 0;
      const maxLen = Math.min(maxLenAll, n - i);
      for (let s = 0; s < nStruct; s++) {
        const d = structDists[s];
        if (d > i || bestLen >= maxLen) break;
        if (data[i - d + bestLen] === data[i + bestLen]) {
          let len = 0;
          const base = i - d;
          while (len < maxLen && data[i + len] === data[base + len]) len++;
          if (len > bestLen) { bestLen = len; bestDist = d; }
          if (d <= NEAR_DIST && len > nearLen) { nearLen = len; nearDist = d; }
        }
      }
      let chain = 0;
      while (cand !== -1 && chain < maxChain && bestLen < maxLen) {
        const dist = i - cand;
        if (dist > 32768) break;
        let len = -1;
        if (bestLen < maxLen && data[cand + bestLen] === data[i + bestLen]) {
          len = 0;
          while (len < maxLen && data[i + len] === data[cand + len]) len++;
          if (len > bestLen) {
            bestLen = len; bestDist = dist;
            if (len >= maxLen) { if (dist <= NEAR_DIST) { nearLen = len; nearDist = dist; } break; }
          }
        }
        if (dist <= NEAR_DIST && nearLen < maxLen) {
          if (len < 0 && data[cand + nearLen] === data[i + nearLen]) {
            len = 0;
            while (len < maxLen && data[i + len] === data[cand + len]) len++;
          }
          if (len > nearLen) { nearLen = len; nearDist = dist; }
        }
        cand = prev[cand];
        chain++;
        if (bestLen >= goodLen && chain >= 8) break;
      }
      if (bestLen >= 3) {
        const mc = ci + lenCost[lengthSymbol(bestLen)] + distCost[distSymbol(bestDist)];
        const j = i + bestLen;
        if (mc < cost[j]) { cost[j] = mc; chLen[j] = bestLen; chDist[j] = bestDist; }
      }
      if (nearLen >= 3 && (nearLen !== bestLen || nearDist !== bestDist)) {
        const mc = ci + lenCost[lengthSymbol(nearLen)] + distCost[distSymbol(nearDist)];
        const j = i + nearLen;
        if (mc < cost[j]) { cost[j] = mc; chLen[j] = nearLen; chDist[j] = nearDist; }
      }
      prev[i] = head[h];
      head[h] = i;
    }
  }
  const kinds = [], vals = [], dists = [];
  let j = n;
  while (j > 0) {
    const len = chLen[j];
    if (len === 0) { kinds.push(0); vals.push(data[j - 1]); dists.push(0); j -= 1; }
    else { kinds.push(1); vals.push(len); dists.push(chDist[j]); j -= len; }
  }
  kinds.reverse(); vals.reverse(); dists.reverse();
  return { kinds, vals, dists };
}

// Emit the parsed symbols as a deflate stream, one dynamic (or fixed, when smaller) block
// per blockBytes of input. Symbols are assigned to the block their start position falls in.
function emitDeflate(data, parsed, blockBytes) {
  const { kinds, vals, dists } = parsed;
  const nSym = kinds.length;
  const starts = new Int32Array(nSym);
  {
    let p = 0;
    for (let s = 0; s < nSym; s++) { starts[s] = p; p += kinds[s] === 0 ? 1 : vals[s]; }
  }
  const nBlocks = Math.max(1, Math.ceil(data.length / blockBytes));
  const w = new BitWriter(data.length + 1024 + nBlocks * 512);
  const fLit = fixedLitLen();
  let s = 0;
  for (let b = 0; b < nBlocks; b++) {
    const blockEnd = Math.min(data.length, (b + 1) * blockBytes);
    let e = s;
    while (e < nSym && starts[e] < blockEnd) e++;
    const isLast = b === nBlocks - 1;
    const litFreq = new Uint32Array(288);
    const distFreq = new Uint32Array(30);
    for (let k = s; k < e; k++) {
      if (kinds[k] === 0) litFreq[vals[k]]++;
      else { litFreq[257 + lengthSymbol(vals[k])]++; distFreq[distSymbol(dists[k])]++; }
    }
    litFreq[256]++;
    let litUsed = 0; for (let i = 0; i < 288; i++) if (litFreq[i] > 0) litUsed++;
    if (litUsed < 2) { for (let i = 0; i < 288; i++) if (litFreq[i] === 0) { litFreq[i] = 1; litUsed++; break; } }
    let distUsed = 0; for (let i = 0; i < 30; i++) if (distFreq[i] > 0) distUsed++;
    if (distUsed === 0) distFreq[0] = 1;
    const litLen = codeLengths(litFreq, 15);
    const distLen = codeLengths(distFreq, 15);
    let dynBits = 0;
    for (let i = 0; i < 288; i++) if (litFreq[i] > 0) dynBits += litFreq[i] * litLen[i];
    for (let i = 0; i < 30; i++) if (distFreq[i] > 0) dynBits += distFreq[i] * distLen[i];
    let fixBits = 0;
    for (let i = 0; i < 288; i++) if (litFreq[i] > 0) fixBits += litFreq[i] * fLit[i];
    for (let i = 0; i < 30; i++) if (distFreq[i] > 0) fixBits += distFreq[i] * 5;
    let hlit = 286, hdist = 30;
    while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
    while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
    const seqLen = hlit + hdist;
    const seq = new Uint8Array(seqLen);
    for (let i = 0; i < hlit; i++) seq[i] = litLen[i];
    for (let i = 0; i < hdist; i++) seq[hlit + i] = distLen[i];
    const clSyms = [];
    {
      let i = 0;
      while (i < seqLen) {
        const v = seq[i];
        let run = 1;
        while (i + run < seqLen && seq[i + run] === v) run++;
        if (v === 0) {
          let r = run;
          while (r >= 11) { const take = Math.min(r, 138); clSyms.push([18, take]); r -= take; }
          if (r >= 3) { clSyms.push([17, r]); r = 0; }
          while (r > 0) { clSyms.push([0, 0]); r--; }
        } else {
          clSyms.push([v, 0]);
          let r = run - 1;
          while (r >= 3) { const take = Math.min(r, 6); clSyms.push([16, take]); r -= take; }
          while (r > 0) { clSyms.push([v, 0]); r--; }
        }
        i += run;
      }
    }
    const clFreq = new Uint32Array(19);
    for (const [sym] of clSyms) clFreq[sym]++;
    const clLen = codeLengths(clFreq, 7);
    let clBits = 0;
    for (const [sym] of clSyms) clBits += clLen[sym];
    for (const [sym, ex] of clSyms) {
      if (sym === 16) clBits += 2;
      else if (sym === 17) clBits += 3;
      else if (sym === 18) clBits += 7;
    }
    let hclen = 19;
    while (hclen > 4 && clLen[CLEN_ORDER[hclen - 1]] === 0) hclen--;
    const dynTotal = 3 + 5 + 5 + 4 + hclen * 3 + clBits + dynBits;
    const fixTotal = 3 + fixBits;
    const useFixed = fixTotal <= dynTotal;
    w.write(isLast ? 1 : 0, 1);
    if (useFixed) {
      w.write(1, 2);
      const { codes: lc } = canonicalCodes(fLit);
      const { codes: dc } = canonicalCodes(FIXED_DIST_LEN);
      for (let k = s; k < e; k++) {
        if (kinds[k] === 0) { w.write(lc[vals[k]], fLit[vals[k]]); }
        else {
          const len = vals[k];
          const ls = lengthSymbol(len);
          w.write(lc[257 + ls], fLit[257 + ls]);
          const eb = LENGTH_EXTRA[ls];
          if (eb > 0) w.write(len - LENGTH_BASE[ls], eb);
          const ds = distSymbol(dists[k]);
          w.write(dc[ds], 5);
          const ed = DIST_EXTRA[ds];
          if (ed > 0) w.write(dists[k] - DIST_BASE[ds], ed);
        }
      }
      w.write(lc[256], fLit[256]);
    } else {
      w.write(2, 2);
      w.write(hlit - 257, 5);
      w.write(hdist - 1, 5);
      w.write(hclen - 4, 4);
      for (let i = 0; i < hclen; i++) w.write(clLen[CLEN_ORDER[i]], 3);
      const { codes: clCodes } = canonicalCodes(clLen);
      for (const [sym, ex] of clSyms) {
        w.write(clCodes[sym], clLen[sym]);
        if (sym === 16) w.write(ex - 3, 2);
        else if (sym === 17) w.write(ex - 3, 3);
        else if (sym === 18) w.write(ex - 11, 7);
      }
      const { codes: lc } = canonicalCodes(litLen);
      const { codes: dc } = canonicalCodes(distLen);
      for (let k = s; k < e; k++) {
        if (kinds[k] === 0) { w.write(lc[vals[k]], litLen[vals[k]]); }
        else {
          const len = vals[k];
          const ls = lengthSymbol(len);
          w.write(lc[257 + ls], litLen[257 + ls]);
          const eb = LENGTH_EXTRA[ls];
          if (eb > 0) w.write(len - LENGTH_BASE[ls], eb);
          const ds = distSymbol(dists[k]);
          w.write(dc[ds], distLen[ds]);
          const ed = DIST_EXTRA[ds];
          if (ed > 0) w.write(dists[k] - DIST_BASE[ds], ed);
        }
      }
      w.write(lc[256], litLen[256]);
    }
    s = e;
  }
  w.align();
  return w.buf.subarray(0, w.pos);
}

// Full deflate: iterate parsing with refined per-block costs, then emit as a zlib stream.
// opts: {maxChain, goodLen, blockBytes, iterations, rowBytes, bpp}
function deflateZlib(data, opts = {}) {
  const maxChain = opts.maxChain ?? 512;
  const goodLen = opts.goodLen ?? 64;
  const blockBytes = opts.blockBytes ?? 262144;
  const iterations = opts.iterations ?? 2;
  const nBlocks = Math.max(1, Math.ceil(data.length / blockBytes));
  const blockOf = (i) => Math.min(nBlocks - 1, (i / blockBytes) | 0);
  let structDists = null;
  if (opts.rowBytes) {
    const bpp = opts.bpp ?? 1;
    structDists = [...new Set([1, bpp, opts.rowBytes, 2 * opts.rowBytes])].filter((d) => d >= 1 && d <= 32768).sort((a, b) => a - b);
  }
  const fLit = fixedLitLen();
  const litCosts = [], lenCosts = [], distCosts = [];
  for (let b = 0; b < nBlocks; b++) {
    const litCost = new Float64Array(288);
    for (let i = 0; i < 288; i++) litCost[i] = fLit[i];
    const lenCost = new Float64Array(29);
    for (let i = 0; i < 29; i++) lenCost[i] = litCost[257 + i] + LENGTH_EXTRA[i];
    const distCost = new Float64Array(30);
    for (let i = 0; i < 30; i++) distCost[i] = 5 + DIST_EXTRA[i];
    litCosts.push(litCost); lenCosts.push(lenCost); distCosts.push(distCost);
  }
  let parsed = null;
  for (let it = 0; it < iterations; it++) {
    parsed = parseDP(data, litCosts, lenCosts, distCosts, maxChain, blockOf, goodLen, structDists);
    const litFreqs = [], distFreqs = [];
    for (let b = 0; b < nBlocks; b++) { litFreqs.push(new Uint32Array(288)); distFreqs.push(new Uint32Array(30)); }
    let pos = 0;
    for (let k = 0; k < parsed.kinds.length; k++) {
      const b = blockOf(pos);
      if (parsed.kinds[k] === 0) { litFreqs[b][parsed.vals[k]]++; pos += 1; }
      else {
        litFreqs[b][257 + lengthSymbol(parsed.vals[k])]++;
        distFreqs[b][distSymbol(parsed.dists[k])]++;
        pos += parsed.vals[k];
      }
    }
    for (let b = 0; b < nBlocks; b++) {
      litFreqs[b][256]++;
      const litLen = codeLengths(litFreqs[b], 15);
      const distLen = codeLengths(distFreqs[b], 15);
      const litCost = litCosts[b], lenCost = lenCosts[b], distCost = distCosts[b];
      for (let i = 0; i < 288; i++) litCost[i] = litLen[i] > 0 ? litLen[i] : 12;
      for (let i = 0; i < 29; i++) lenCost[i] = (litLen[257 + i] > 0 ? litLen[257 + i] : 12) + LENGTH_EXTRA[i];
      for (let i = 0; i < 30; i++) distCost[i] = (distLen[i] > 0 ? distLen[i] : 8) + DIST_EXTRA[i];
    }
  }
  const raw = emitDeflate(data, parsed, blockBytes);
  const out = new Uint8Array(raw.length + 6);
  out[0] = 0x78; out[1] = 0xda;
  out.set(raw, 2);
  const ad = adler32(data);
  out[out.length - 4] = (ad >>> 24) & 0xff;
  out[out.length - 3] = (ad >>> 16) & 0xff;
  out[out.length - 2] = (ad >>> 8) & 0xff;
  out[out.length - 1] = ad & 0xff;
  return out;
}

// ---------------------------------------------------------------- driver
const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
// Bytes of fixed PNG overhead around the IDAT stream (signature + IHDR + IEND + IDAT header).
const PNG_OVERHEAD = 57;
// Screening level for ranking filter/form candidates (fast, ranks like level 9 here).
const SCREEN_LEVEL = 6;
// Work budget for the final deflate, by filtered size: small images get a second
// cost-refinement iteration, large ones one (the gain of the second pass is ~1%).
const SMALL_RAW_MAX = 1100000;

for (const id of readdirSync(INPUT_DIR).sort()) {
  const decoded = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  const { width, height, rgba } = decoded;
  const forms = formsOf(rgba);
  let best = null;
  for (const form of forms) {
    const { variants, pairs } = filteredVariants(form.samples, width, height, form.bpp);
    for (const f of form.filters) {
      const data = f === 'pairs' ? pairs : variants[f];
      const z = deflateSync(data, { level: SCREEN_LEVEL, memLevel: 9 });
      const total = z.length + chunkBytes(form) + PNG_OVERHEAD;
      if (best === null || total < best.total) best = { form, data, total };
    }
  }
  const rowBytes = width * best.form.bpp + 1;
  const iterations = best.data.length <= SMALL_RAW_MAX ? 2 : 1;
  const mine = deflateZlib(best.data, {
    maxChain: 512, goodLen: 64, blockBytes: 262144,
    iterations, rowBytes, bpp: best.form.bpp,
  });
  const z9 = deflateSync(best.data, { level: 9, memLevel: 9 });
  const idat = mine.length <= z9.length ? mine : z9;
  const chunks = [['IHDR', ihdrOf(width, height, best.form.colourType)]];
  if (best.form.plte !== null) chunks.push(['PLTE', best.form.plte]);
  if (best.form.trns !== null) chunks.push(['tRNS', best.form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), pngOf(chunks));
}

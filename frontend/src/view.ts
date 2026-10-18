/** Viewport math and level-of-detail rules for the chromosome map. */

export interface View {
  chrom: string;
  /** Genomic coordinate (0-based, fractional) at the horizontal center of the map. */
  center: number;
  /** Base pairs per CSS pixel. Smaller = more zoomed in. */
  bpp: number;
}

export const MIN_BPP = 1 / 24; // 24 px per base at maximum zoom
export const maxBpp = (length: number, width: number) => length / Math.max(200, width * 0.94);

export const LOD = {
  /** Draw individual genes below this bp/px, gene density heat above. */
  genes: 4000,
  /** Draw individual variant markers below this bp/px. */
  variants: 20000,
  /** Fetch and draw reference sequence below this bp/px. */
  sequence: 8,
  /** Draw base letters below this bp/px (≥ 9 px per base). */
  letters: 1 / 9,
};

export const SEQUENCE_TILE = 4096;

const pow2ceil = (x: number) => 2 ** Math.ceil(Math.log2(Math.max(1, x)));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export const tileSize = {
  genes: (bpp: number) => clamp(pow2ceil(bpp * 1024), 65536, 4194304),
  density: (bpp: number) => pow2ceil(bpp * 512),
  variants: (bpp: number) => clamp(pow2ceil(bpp * 1024), 65536, 2 ** 25),
};
export const DENSITY_BINS = 128;

export function clampView(v: View, length: number, width: number): View {
  const bpp = clamp(v.bpp, MIN_BPP, maxBpp(length, width));
  const span = width * bpp;
  if (span >= length) return { ...v, bpp, center: length / 2 };
  // Allow panning a little past the ends, like a map edge.
  const margin = span * 0.1;
  return { ...v, bpp, center: clamp(v.center, span / 2 - margin, length - span / 2 + margin) };
}

export function viewRange(v: View, width: number): [number, number] {
  const half = (width * v.bpp) / 2;
  return [v.center - half, v.center + half];
}

export function fitRange(chrom: string, start: number, end: number, width: number, pad = 1.3): View {
  const span = Math.max(40, (end - start) * pad);
  return { chrom, center: (start + end) / 2, bpp: span / width };
}

/** Zoom level like a map: 0 = whole chromosome, increasing as you zoom in. */
export const zoomLevel = (v: View, length: number, width: number) =>
  Math.log2(maxBpp(length, width) / v.bpp);

export function formatBp(bp: number, digits = 1): string {
  const a = Math.abs(bp);
  if (a >= 1e6) return `${+(bp / 1e6).toFixed(digits)} Mb`;
  if (a >= 1e3) return `${+(bp / 1e3).toFixed(digits)} kb`;
  return `${Math.round(bp)} bp`;
}

export const formatPos = (n: number) => Math.round(n).toLocaleString("en-US");

/** "Nice" tick spacing for a ruler: 1, 2 or 5 × 10^k bp, at least `minPx` apart. */
export function tickStep(bpp: number, minPx = 90): number {
  const raw = bpp * minPx;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (p * m >= raw) return Math.max(1, p * m);
  return p * 10;
}

export const shortChrom = (c: string) => c.replace(/^chr/, "");

// ---- URL hash: #chr7:117,480,025-117,668,665 --------------------------------

export function viewToHash(v: View | null, width: number): string {
  if (!v) return "";
  const [s, e] = viewRange(v, width);
  return `#${v.chrom}:${Math.max(1, Math.round(s) + 1)}-${Math.round(e)}`;
}

export function hashToRange(hash: string): { chrom: string; start: number; end: number } | null {
  const m = decodeURIComponent(hash).match(/^#(chr[0-9XYM]+)(?::([\d,]+)-([\d,]+))?$/i);
  if (!m) return null;
  const chrom = "chr" + m[1].slice(3).toUpperCase();
  if (!m[2]) return { chrom, start: 0, end: Infinity };
  return { chrom, start: +m[2].replace(/,/g, "") - 1, end: +m[3].replace(/,/g, "") };
}

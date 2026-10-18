import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chromosome, ClinicalFinding, Gene, GeneSummary, TileCache, Variant, tileStarts, tileUrl } from "./api";
import { BASE, CLIN, COMPLEMENT, STAIN, VARIANT, formatAf, geneColor } from "./theme";
import { CLIN_PLAIN, findingTitle, friendlyCount, letters as lettersText } from "./plain";
import {
  DENSITY_BINS,
  LOD,
  MIN_BPP,
  SEQUENCE_TILE,
  View,
  clampView,
  formatBp,
  formatPos,
  maxBpp,
  shortChrom,
  tickStep,
  tileSize,
  viewRange,
} from "./view";

interface Props {
  chromosome: Chromosome;
  view: View;
  width: number;
  height: number;
  top: number; // px reserved at the top for floating controls
  setView: (v: View) => void;
  animateTo: (v: View) => void;
  uploadId: string | null;
  showSensitive: boolean;
  clinical: ClinicalFinding[];
  selectedGeneId: number | null;
  pins: GeneSummary[];
  onSelectGene: (id: number) => void;
  onExit: () => void;
  /** Detailed (scientific) view: rulers, bands, both strands, technical labels. */
  expert: boolean;
  /** The gene under the center of the view, for the breadcrumb. */
  onCenterGene: (g: Gene | null) => void;
}

type Hit =
  | { kind: "gene"; gene: Gene; x0: number; x1: number; y0: number; y1: number }
  | { kind: "pin"; gene: GeneSummary; x0: number; x1: number; y0: number; y1: number }
  | { kind: "variant"; v: Variant; x0: number; x1: number; y0: number; y1: number }
  | { kind: "clinical"; f: ClinicalFinding; x0: number; x1: number; y0: number; y1: number };

const IDEO_X0 = 156;
const ROW_H = 34;
const FONT = "Inter, system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";

export default function ChromosomeView(props: Props) {
  const { chromosome, view, width, height, top, setView, animateTo, uploadId, onExit, expert } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [version, setVersion] = useState(0);
  const cache = useMemo(() => new TileCache(() => setVersion((v) => v + 1)), []);
  const hits = useRef<Hit[]>([]);
  const [hover, setHover] = useState<{ hit: Hit; x: number; y: number } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const centerGene = useRef<Gene | null>(null);
  const length = chromosome.length;

  const layout = useMemo(() => {
    const ideoY = top + 44; // below the breadcrumb
    const bandsY = ideoY + 36;
    const rulerY = bandsY + 24;
    // Simple view skips the cytoband strip and coordinate ruler.
    let y = expert ? rulerY + 34 : ideoY + 40;
    const showSeq = view.bpp <= LOD.sequence;
    const letters = view.bpp <= LOD.letters;
    const seqY = y;
    if (showSeq) y += letters ? (expert ? 46 : 26) : 20;
    const dnaY = y;
    if (uploadId) y += letters ? 40 : 34;
    return { ideoY, bandsY, rulerY, seqY, showSeq, letters, dnaY, genesY: y + 8 };
  }, [top, view.bpp, uploadId, expert]);

  // ---- drawing ------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    hits.current = [];
    const [start, end] = viewRange(view, width);
    const X = (bp: number) => (bp - start) / view.bpp;

    drawIdeogram(ctx, chromosome, width, layout.ideoY, start, end, props.pins);
    if (expert) {
      drawBandStrip(ctx, chromosome, layout.bandsY, width, start, end, X, view.bpp);
      drawRuler(ctx, layout.rulerY, width, start, end, X, view.bpp);
    }
    if (layout.showSeq) drawSequence(ctx, cache, chromosome.name, layout.seqY, width, start, end, X, view.bpp, expert);
    if (uploadId) {
      drawVariants(ctx, cache, uploadId, chromosome.name, layout.dnaY, width, start, end, X, view.bpp,
        props.showSensitive, props.clinical, hits.current);
    }
    const shown = drawGenes(ctx, cache, chromosome.name, layout.genesY, width, height, start, end, X, view.bpp,
      props.selectedGeneId, props.pins, hits.current, expert);

    // Smallest gene under the center line names the "gene" breadcrumb.
    const atCenter = shown.filter((g) => g.start <= view.center && g.end >= view.center)
      .sort((a, b) => a.end - a.start - (b.end - b.start))[0] ?? null;
    if (atCenter?.id !== centerGene.current?.id) {
      centerGene.current = atCenter;
      props.onCenterGene(atCenter);
    }
  }, [view, width, height, version, chromosome, layout, uploadId, props.selectedGeneId, props.pins, cache,
    props.showSensitive, props.clinical, expert]);

  // ---- interaction --------------------------------------------------------

  const zoomAt = useCallback(
    (x: number, factor: number) => {
      const v = viewRef.current;
      const pivot = v.center + (x - width / 2) * v.bpp;
      const bpp = v.bpp * factor;
      setView(clampView({ ...v, bpp, center: pivot - (x - width / 2) * bpp }, length, width));
    },
    [setView, width, length],
  );

  const exitAccum = useRef(0);
  useEffect(() => {
    const canvas = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.ctrlKey) {
        setView(clampView({ ...v, center: v.center + e.deltaX * v.bpp }, length, width));
        return;
      }
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const atMax = v.bpp >= maxBpp(length, width) * 0.999;
      if (dy > 0 && atMax) {
        exitAccum.current += dy;
        if (exitAccum.current > 240) {
          exitAccum.current = 0;
          onExit();
        }
        return;
      }
      exitAccum.current = 0;
      zoomAt(e.offsetX, Math.exp(dy * (e.ctrlKey ? 0.012 : 0.0022)));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [zoomAt, setView, length, width, onExit]);

  const drag = useRef<{ x: number; startX: number; t: number; vx: number; moved: boolean } | null>(null);
  const inertia = useRef(0);

  const hitAt = (x: number, y: number): Hit | null => {
    for (let i = hits.current.length - 1; i >= 0; i--) {
      const h = hits.current[i];
      if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return h;
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    cancelAnimationFrame(inertia.current);
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, startX: e.clientX, t: performance.now(), vx: 0, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x;
      const now = performance.now();
      d.vx = 0.8 * (dx / Math.max(1, now - d.t)) + 0.2 * d.vx;
      d.x = e.clientX;
      d.t = now;
      if (Math.abs(e.clientX - d.startX) > 3) d.moved = true;
      // Dragging on the ideogram scrubs the whole chromosome; elsewhere it pans.
      const v = viewRef.current;
      const scale = y < layout.bandsY ? -length / (width - IDEO_X0 - 24) : v.bpp;
      setView(clampView({ ...v, center: v.center - dx * scale }, length, width));
      setHover(null);
      return;
    }
    const hit = hitAt(x, y);
    setHover(hit ? { hit, x, y } : null);
    canvasRef.current!.style.cursor = hit || y < layout.bandsY ? "pointer" : "grab";
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (!d.moved) {
      if (y >= layout.ideoY && y < layout.bandsY && x >= IDEO_X0) {
        const bp = ((x - IDEO_X0) / (width - IDEO_X0 - 24)) * length;
        animateTo(clampView({ ...viewRef.current, center: bp }, length, width));
        return;
      }
      const hit = hitAt(x, y);
      if (hit?.kind === "gene" || hit?.kind === "pin") props.onSelectGene(hit.gene.id);
      if (hit?.kind === "clinical") {
        animateTo(clampView({ ...viewRef.current, center: hit.f.pos - 0.5, bpp: 1 / 14 }, length, width));
      }
      return;
    }
    // Map-style inertia after a fling.
    let vx = performance.now() - d.t < 60 ? d.vx : 0;
    const step = () => {
      if (Math.abs(vx) < 0.02) return;
      const v = viewRef.current;
      setView(clampView({ ...v, center: v.center - vx * 16 * v.bpp }, length, width));
      vx *= 0.92;
      inertia.current = requestAnimationFrame(step);
    };
    inertia.current = requestAnimationFrame(step);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const v = viewRef.current;
    const x = e.nativeEvent.offsetX;
    const factor = e.shiftKey ? 2 : 0.5;
    const pivot = v.center + (x - width / 2) * v.bpp;
    const bpp = v.bpp * factor;
    animateTo(clampView({ ...v, bpp, center: pivot - (x - width / 2) * bpp }, length, width));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      const v = viewRef.current;
      const pan = (dir: number) => animateTo(clampView({ ...v, center: v.center + dir * width * 0.4 * v.bpp }, length, width));
      if (e.key === "+" || e.key === "=") zoomAt(width / 2, 0.5);
      else if (e.key === "-" || e.key === "_") {
        if (v.bpp >= maxBpp(length, width) * 0.999) onExit();
        else zoomAt(width / 2, 2);
      } else if (e.key === "ArrowLeft") pan(-1);
      else if (e.key === "ArrowRight") pan(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomAt, animateTo, onExit, width, length]);

  const [start, end] = viewRange(view, width);
  const scale = scaleBar(view.bpp);

  return (
    <div className="chrom-view">
      <canvas
        ref={canvasRef}
        style={{ width, height, touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={onDoubleClick}
      />
      {hover && <Tooltip hit={hover.hit} x={hover.x} y={hover.y} width={width} expert={expert} />}
      <div className="scale-bar">
        <div className="scale-bar-line" style={{ width: scale.px }} />
        <span>{expert ? scale.label : lettersText(scale.bp)}</span>
      </div>
      <div className={`coords ${expert ? "" : "simple"}`}>
        {expert ? (
          <>
            {shortChrom(chromosome.name)}:{formatPos(Math.max(1, start + 1))}–{formatPos(Math.min(length, end))}
            <span className="coords-span"> · {formatBp(Math.min(length, end) - Math.max(0, start))} visible</span>
          </>
        ) : (
          <>Showing {lettersText(Math.min(length, end) - Math.max(0, start))} of {friendlyCount(length)}</>
        )}
        {cache.loading > 0 && <span className="loading-dot" title="Loading" />}
      </div>
      {view.bpp <= MIN_BPP * 1.01 && (
        <div className="max-zoom-hint">
          {expert ? "Maximum zoom · single base pairs" : "You've zoomed all the way in — these are individual DNA letters"}
        </div>
      )}
    </div>
  );
}

function scaleBar(bpp: number) {
  const target = 120 * bpp;
  const p = 10 ** Math.floor(Math.log10(target));
  const nice = [5, 2, 1].map((m) => m * p).find((n) => n <= target) ?? p;
  return { px: nice / bpp, label: formatBp(nice, 0), bp: nice };
}

function Tooltip({ hit, x, y, width, expert }: { hit: Hit; x: number; y: number; width: number; expert: boolean }) {
  const left = Math.min(x + 14, width - 300);
  if (!expert) return <SimpleTooltip hit={hit} left={left} top={y + 14} />;
  if (hit.kind === "clinical") {
    const f = hit.f;
    return (
      <div className="tooltip" style={{ left, top: y + 14 }}>
        <b style={{ color: CLIN[f.class].color }}>{CLIN[f.class].label}</b> · {f.gene} {f.rsid}
        <div>{f.conditions.slice(0, 2).join("; ") || f.significance}</div>
        <div className="muted">
          You <code>{f.genotype}</code> · {f.copies} cop{f.copies === 1 ? "y" : "ies"} of {f.alt} · click to zoom in
        </div>
      </div>
    );
  }
  if (hit.kind === "variant") {
    const v = hit.v;
    const cv = v.clinvar;
    return (
      <div className="tooltip" style={{ left, top: y + 14 }}>
        <b>{v.rsid}</b> · position {formatPos(v.pos)}
        <div>
          Reference <code>{v.ref}</code> · You <code>{v.genotype}</code>
        </div>
        <div className="muted">{v.zygosity === 2 ? "Homozygous" : "Heterozygous"} difference from reference</div>
        {cv && (
          <div className="tooltip-clin">
            <b style={{ color: CLIN[cv.class].color }}>ClinVar: {cv.significance}</b>
            {cv.conditions.length > 0 && <div>{cv.conditions.slice(0, 3).join("; ")}</div>}
            <div className="muted">
              {"★".repeat(cv.stars)}{"☆".repeat(4 - cv.stars)} {cv.review} · {formatAf(v.af, v.afSource)}
            </div>
          </div>
        )}
        {v.hiddenSensitive && <div className="muted">ClinVar finding in a sensitive gene — hidden (see Your DNA)</div>}
      </div>
    );
  }
  const g = hit.gene;
  return (
    <div className="tooltip" style={{ left, top: y + 14 }}>
      <b>{g.symbol}</b> <span className="muted">{g.type}</span>
      <div>{g.description}</div>
      <div className="muted">
        {formatBp(g.end - g.start)} · {g.strand === "+" ? "forward" : "reverse"} strand · click for details
      </div>
    </div>
  );
}

function SimpleTooltip({ hit, left, top }: { hit: Hit; left: number; top: number }) {
  if (hit.kind === "clinical") {
    const f = hit.f;
    return (
      <div className="tooltip" style={{ left, top }}>
        <b style={{ color: CLIN_PLAIN[f.class].color }}>{CLIN_PLAIN[f.class].badge}</b>
        <div>{findingTitle(f)}</div>
        <div className="muted">Click to zoom in · details in “Your DNA”</div>
      </div>
    );
  }
  if (hit.kind === "variant") {
    const v = hit.v;
    const yours = v.genotype.split("");
    return (
      <div className="tooltip" style={{ left, top }}>
        <b>A spot where your DNA differs</b>
        <div>
          The reference genome has <code>{v.ref}</code>. You have{" "}
          {yours.length === 2 ? <><code>{yours[0]}</code> and <code>{yours[1]}</code></> : <code>{yours[0]}</code>}.
        </div>
        <div className="muted">
          {v.zygosity === 2
            ? "Both of your copies differ from the reference."
            : "One of your two copies differs from the reference."}{" "}
          Differences like this are common and usually harmless.
        </div>
        {v.clinvar && NOTABLE.has(v.clinvar.class) && (
          <div className="tooltip-clin">
            <b style={{ color: CLIN_PLAIN[v.clinvar.class].color }}>{CLIN_PLAIN[v.clinvar.class].badge}</b> — see “Your DNA”
          </div>
        )}
      </div>
    );
  }
  const g = hit.gene;
  return (
    <div className="tooltip" style={{ left, top }}>
      <b>{g.symbol}</b> <span className="muted">gene</span>
      <div>{g.blurb ?? g.description}</div>
      <div className="muted">{lettersText(g.end - g.start)} long · click to learn more</div>
    </div>
  );
}

// ---- track renderers ------------------------------------------------------

type Ctx = CanvasRenderingContext2D;

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

function drawIdeogram(ctx: Ctx, c: Chromosome, width: number, y: number, start: number, end: number, pins: GeneSummary[]) {
  const x0 = IDEO_X0;
  const w = width - x0 - 24;
  const h = 18;
  const s = w / c.length;
  ctx.font = `600 15px ${FONT}`;
  ctx.fillStyle = "#202124";
  ctx.textBaseline = "middle";
  ctx.fillText(`Chromosome ${shortChrom(c.name)}`, 20, y + h / 2);

  ctx.save();
  roundRect(ctx, x0, y, w, h, 9);
  ctx.clip();
  ctx.fillStyle = STAIN.gneg;
  ctx.fillRect(x0, y, w, h);
  for (const [bs, be, , stain] of c.bands) {
    ctx.fillStyle = STAIN[stain] ?? STAIN.gneg;
    if (stain === "acen") ctx.fillRect(x0 + bs * s, y + 4, (be - bs) * s + 0.5, h - 8);
    else ctx.fillRect(x0 + bs * s, y, (be - bs) * s + 0.5, h);
  }
  ctx.restore();
  roundRect(ctx, x0, y, w, h, 9);
  ctx.strokeStyle = "#80868b";
  ctx.lineWidth = 1;
  ctx.stroke();

  for (const p of pins) {
    const px = x0 + ((p.start + p.end) / 2) * s;
    ctx.fillStyle = geneColor(p.categories, p.type);
    ctx.beginPath();
    ctx.moveTo(px, y - 1);
    ctx.lineTo(px - 4, y - 7);
    ctx.lineTo(px + 4, y - 7);
    ctx.fill();
  }

  // Current viewport window.
  const vx0 = x0 + Math.max(0, start) * s;
  const vx1 = x0 + Math.min(c.length, end) * s;
  const vw = Math.max(3, vx1 - vx0);
  ctx.fillStyle = "rgba(234, 67, 53, 0.12)";
  ctx.strokeStyle = "#ea4335";
  ctx.lineWidth = 2;
  roundRect(ctx, vx0 - (vw === 3 ? 1.5 : 0), y - 3, vw, h + 6, 3);
  ctx.fill();
  ctx.stroke();
}

function drawBandStrip(ctx: Ctx, c: Chromosome, y: number, width: number, start: number, end: number,
  X: (bp: number) => number, bpp: number) {
  const h = 16;
  ctx.font = `500 10px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  for (const [bs, be, name, stain] of c.bands) {
    if (be < start || bs > end) continue;
    const x0 = Math.max(-2, X(bs));
    const x1 = Math.min(width + 2, X(be));
    ctx.fillStyle = STAIN[stain] ?? STAIN.gneg;
    ctx.fillRect(x0, y, x1 - x0, h);
    if (x1 - x0 > 34) {
      ctx.fillStyle = stain === "gpos75" || stain === "gpos100" ? "#fff" : "#3c4043";
      ctx.fillText(`${shortChrom(c.name)}${name}`, (x0 + x1) / 2, y + h / 2 + 0.5);
    }
  }
  ctx.textAlign = "left";
  // Chromosome ends.
  ctx.fillStyle = "#e8eaed";
  if (start < 0) ctx.fillRect(0, y, X(0), h);
  if (end > c.length) ctx.fillRect(X(c.length), y, width - X(c.length), h);
  void bpp;
}

function drawRuler(ctx: Ctx, y: number, width: number, start: number, end: number, X: (bp: number) => number, bpp: number) {
  const step = tickStep(bpp);
  ctx.strokeStyle = "#bdc1c6";
  ctx.fillStyle = "#5f6368";
  ctx.lineWidth = 1;
  ctx.font = `500 11px ${FONT}`;
  ctx.textBaseline = "top";
  ctx.beginPath();
  ctx.moveTo(0, y + 0.5);
  ctx.lineTo(width, y + 0.5);
  ctx.stroke();
  const minor = step / 5;
  for (let p = Math.ceil(Math.max(0, start) / minor) * minor; p <= end; p += minor) {
    const x = Math.round(X(p)) + 0.5;
    const major = Math.abs(p / step - Math.round(p / step)) < 1e-6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + (major ? 8 : 4));
    ctx.stroke();
    if (major) {
      const label = step >= 1e6 ? `${p / 1e6} Mb` : step >= 1e4 ? `${(p / 1e3).toLocaleString()} kb` : formatPos(p);
      ctx.fillText(label, x + 3, y + 10);
    }
  }
}

function drawSequence(ctx: Ctx, cache: TileCache, chrom: string, y: number, width: number, start: number, end: number,
  X: (bp: number) => number, bpp: number, expert: boolean) {
  const letters = bpp <= LOD.letters;
  const pxPerBase = 1 / bpp;
  const h = letters ? 20 : 14;
  for (const t of tileStarts(start, end, SEQUENCE_TILE)) {
    const tile = cache.get<{ start: number; sequence: string }>(tileUrl.sequence(chrom, t, SEQUENCE_TILE));
    if (!tile) {
      ctx.fillStyle = "#f1f3f4";
      ctx.fillRect(X(t), y, SEQUENCE_TILE * pxPerBase, h);
      continue;
    }
    const seq = tile.sequence;
    const i0 = Math.max(0, Math.floor(start - tile.start));
    const i1 = Math.min(seq.length, Math.ceil(end - tile.start) + 1);
    for (let i = i0; i < i1; i++) {
      const ch = seq[i];
      const up = ch.toUpperCase();
      const x = X(tile.start + i);
      ctx.globalAlpha = ch === up ? 1 : 0.55; // soft-masked repeats are lighter
      ctx.fillStyle = BASE[up] ?? BASE.N;
      if (letters) {
        ctx.fillRect(x + 0.5, y, pxPerBase - 1, h);
        if (expert) ctx.fillRect(x + 0.5, y + h + 4, pxPerBase - 1, h);
      } else {
        ctx.fillRect(x, y, Math.max(1, pxPerBase), h);
      }
    }
    ctx.globalAlpha = 1;
    if (letters) {
      ctx.font = `500 ${Math.min(14, pxPerBase * 0.62)}px ${MONO}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#fff";
      for (let i = i0; i < i1; i++) {
        const up = seq[i].toUpperCase();
        const cx = X(tile.start + i) + pxPerBase / 2;
        ctx.fillText(up, cx, y + h / 2 + 1);
        if (expert) ctx.fillText(COMPLEMENT[up] ?? "N", cx, y + h + 4 + h / 2 + 1);
      }
      ctx.textAlign = "left";
    }
  }
  ctx.fillStyle = "#5f6368";
  ctx.font = `500 10px ${FONT}`;
  ctx.textBaseline = "bottom";
  if (letters && expert) {
    trackLabel(ctx, "5′ → forward", 8, y + h - 2);
    trackLabel(ctx, "3′ ← reverse", 8, y + 2 * h + 2);
  } else if (letters) {
    trackLabel(ctx, "Reference DNA", 8, y + h - 2);
  }
  void width;
}

function trackLabel(ctx: Ctx, text: string, x: number, y: number) {
  ctx.font = `600 10px ${FONT}`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.fillRect(x - 4, y - 13, w + 8, 15);
  ctx.fillStyle = "#3c4043";
  ctx.textBaseline = "bottom";
  ctx.fillText(text, x, y);
}

const NOTABLE = new Set(["pathogenic", "risk", "drug"]);

function drawVariants(ctx: Ctx, cache: TileCache, upload: string, chrom: string, y: number, width: number,
  start: number, end: number, X: (bp: number) => number, bpp: number, sensitive: boolean,
  clinical: ClinicalFinding[], hits: Hit[]) {
  const h = 24;
  ctx.fillStyle = "#fef7e0";
  ctx.fillRect(0, y, width, h);
  const letters = bpp <= LOD.letters;

  if (bpp > LOD.variants) {
    const size = tileSize.density(bpp);
    for (const t of tileStarts(start, end, size)) {
      const tile = cache.get<{ bins: number[] }>(tileUrl.variants(upload, chrom, t, size, DENSITY_BINS));
      if (!tile) continue;
      const max = Math.max(4, ...tile.bins);
      const bw = size / DENSITY_BINS / bpp;
      tile.bins.forEach((n, i) => {
        if (!n) return;
        const bh = Math.max(2, (n / max) * (h - 4));
        ctx.fillStyle = VARIANT.het;
        ctx.fillRect(X(t) + i * bw, y + h - 2 - bh, Math.max(1, bw - 0.5), bh);
      });
    }
  } else {
    const size = tileSize.variants(bpp);
    for (const t of tileStarts(start, end, size)) {
      const tile = cache.get<{ variants: Variant[] }>(tileUrl.variants(upload, chrom, t, size, undefined, sensitive));
      if (!tile) continue;
      for (const v of tile.variants) {
        const x = X(v.pos - 1);
        if (x < -20 || x > width + 20) continue;
        const notable = v.clinvar && NOTABLE.has(v.clinvar.class);
        ctx.fillStyle = notable ? CLIN[v.clinvar!.class].color : v.zygosity === 2 ? VARIANT.homAlt : VARIANT.het;
        if (letters) {
          const pw = 1 / bpp;
          roundRect(ctx, x + 0.5, y + 1, pw - 1, h + 6, 3);
          ctx.fill();
          ctx.fillStyle = "#fff";
          ctx.font = `600 ${Math.min(12, pw * 0.42)}px ${MONO}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(v.genotype.split("").join("/"), x + pw / 2, y + h / 2 + 4);
          ctx.textAlign = "left";
          hits.push({ kind: "variant", v, x0: x, x1: x + pw, y0: y, y1: y + h + 6 });
        } else {
          const w = Math.max(notable ? 3 : 2, 1 / bpp);
          ctx.fillRect(x, y + (notable ? 1 : 3), w, h - (notable ? 2 : 6));
          hits.push({ kind: "variant", v, x0: x - 3, x1: x + w + 3, y0: y, y1: y + h });
        }
      }
    }
  }

  // ClinVar findings stay visible as diamonds at every zoom level, like map landmarks.
  if (!letters) {
    for (const f of clinical) {
      const x = X(f.pos - 0.5);
      if (x < -10 || x > width + 10) continue;
      const cy = y + h / 2;
      ctx.fillStyle = CLIN[f.class].color;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, cy - 8);
      ctx.lineTo(x + 7, cy);
      ctx.lineTo(x, cy + 8);
      ctx.lineTo(x - 7, cy);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      hits.push({ kind: "clinical", f, x0: x - 8, x1: x + 8, y0: cy - 9, y1: cy + 9 });
    }
  }
  trackLabel(ctx, "Your DNA", 8, y + 15);
}

function drawGenes(ctx: Ctx, cache: TileCache, chrom: string, y: number, width: number, height: number,
  start: number, end: number, X: (bp: number) => number, bpp: number, selected: number | null,
  pins: GeneSummary[], hits: Hit[], expert: boolean): Gene[] {
  const pinIds = new Set(pins.map((p) => p.id));

  if (bpp > LOD.genes) {
    // Zoomed out: gene density "terrain" plus pins for highlighted genes.
    const size = tileSize.density(bpp);
    const h = 70;
    const base = y + 40 + h;
    let loaded = 0;
    for (const t of tileStarts(start, end, size)) {
      const tile = cache.get<{ bins: number[] }>(tileUrl.density(chrom, t, size, DENSITY_BINS));
      if (!tile) continue;
      loaded++;
      const binBp = size / DENSITY_BINS;
      const bw = binBp / bpp;
      tile.bins.forEach((n, i) => {
        const perMb = (n / binBp) * 1e6;
        const bh = Math.min(h, (perMb / 40) * h);
        ctx.fillStyle = `hsl(214, 82%, ${78 - Math.min(1, perMb / 40) * 30}%)`;
        ctx.fillRect(X(t) + i * bw, base - bh, Math.max(1, bw - 0.4), bh);
      });
    }
    ctx.strokeStyle = "#dadce0";
    ctx.beginPath();
    ctx.moveTo(0, base + 0.5);
    ctx.lineTo(width, base + 0.5);
    ctx.stroke();
    if (loaded) {
      trackLabel(ctx, expert ? "Gene density · zoom in to see individual genes"
        : "Taller bars = more genes packed in here · zoom in to see them", 8, y + 28);
    }
    drawPins(ctx, pins, base + 26, X, width, selected, hits);
    return [];
  }

  const size = tileSize.genes(bpp);
  const seen = new Set<number>();
  const genes: Gene[] = [];
  for (const t of tileStarts(start, end, size)) {
    const tile = cache.get<{ genes: Gene[] }>(tileUrl.genes(chrom, t, size));
    if (!tile) continue;
    for (const g of tile.genes) {
      if (!seen.has(g.id) && g.end > start - 50 * bpp && g.start < end + 50 * bpp) {
        seen.add(g.id);
        genes.push(g);
      }
    }
  }
  genes.sort((a, b) => a.start - b.start || b.end - a.end);

  ctx.font = `600 12px ${FONT}`;
  // Like a map naming only major streets: when crowded, simple view labels just the well-known genes.
  const crowded = !expert && genes.filter((g) => g.end > start && g.start < end).length > 25;
  const labelled = (g: Gene) => !crowded || g.blurb != null || pinIds.has(g.id) || g.id === selected;
  const maxRows = Math.max(1, Math.floor((height - y - 40) / ROW_H));
  const rowEnds: number[] = [];
  let hidden = 0;
  const placed: { g: Gene; row: number; x0: number; x1: number; lx: number; label: boolean }[] = [];
  for (const g of genes) {
    const x0 = X(g.start);
    const x1 = Math.max(x0 + 1, X(g.end));
    const vis0 = Math.max(x0, 0);
    const vis1 = Math.min(x1, width);
    const label = labelled(g);
    const lw = label ? ctx.measureText(g.symbol).width : 0;
    const lx = Math.min(Math.max((vis0 + vis1) / 2 - lw / 2, 4), width - lw - 4);
    const e0 = Math.min(x0, lx) - 8;
    const e1 = Math.max(x1, lx + lw) + 8;
    let row = rowEnds.findIndex((re) => re <= e0);
    if (row === -1) {
      if (rowEnds.length >= maxRows) {
        hidden++;
        continue;
      }
      row = rowEnds.length;
      rowEnds.push(e1);
    } else rowEnds[row] = e1;
    placed.push({ g, row, x0, x1, lx, label });
  }

  for (const { g, row, x0, x1, lx, label } of placed) {
    const ry = y + row * ROW_H;
    const mid = ry + 9;
    const color = geneColor(g.categories, g.type);
    const isSel = g.id === selected;
    const isPin = pinIds.has(g.id);

    if (isSel || isPin) {
      ctx.fillStyle = isSel ? "rgba(26,115,232,0.14)" : "rgba(251,188,4,0.22)";
      roundRect(ctx, Math.max(-4, x0 - 4), ry - 3, Math.min(width + 8, x1 + 4) - Math.max(-4, x0 - 4), ROW_H - 2, 6);
      ctx.fill();
    }

    // Intron backbone
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(Math.max(-2, x0), mid + 0.5);
    ctx.lineTo(Math.min(width + 2, x1), mid + 0.5);
    ctx.stroke();

    // Strand chevrons along the backbone
    if (x1 - x0 > 30) {
      ctx.lineWidth = 1;
      const dir = g.strand === "+" ? 1 : -1;
      for (let cx = Math.max(x0, 0) + 12; cx < Math.min(x1, width) - 6; cx += 26) {
        ctx.beginPath();
        ctx.moveTo(cx - 2.5 * dir, mid - 3);
        ctx.lineTo(cx + 2.5 * dir, mid + 0.5);
        ctx.lineTo(cx - 2.5 * dir, mid + 4);
        ctx.stroke();
      }
    }

    // Exons: thick for coding, thinner for UTRs
    ctx.fillStyle = color;
    for (const [es, ee] of g.exons) {
      if (ee < start || es > end) continue;
      const pieces: [number, number, number][] = [];
      const cs = Math.max(es, g.cdsStart);
      const ce = Math.min(ee, g.cdsEnd);
      if (g.cdsStart >= g.cdsEnd || ce <= cs) pieces.push([es, ee, 5]);
      else {
        if (es < cs) pieces.push([es, cs, 5]);
        pieces.push([cs, ce, 8]);
        if (ce < ee) pieces.push([ce, ee, 5]);
      }
      for (const [a, b, hh] of pieces) {
        const ax = Math.max(-2, X(a));
        const bx = Math.min(width + 2, X(b));
        ctx.fillRect(ax, mid - hh + 0.5, Math.max(1, bx - ax), hh * 2);
      }
    }

    ctx.fillStyle = isSel ? "#174ea6" : "#202124";
    ctx.font = `${isSel || isPin ? 700 : 600} 12px ${FONT}`;
    ctx.textBaseline = "top";
    if (label) ctx.fillText(g.symbol, lx, ry + 18);
    hits.push({ kind: "gene", gene: g, x0: Math.min(x0, lx) - 2, x1: Math.max(x1, lx + 40) + 2, y0: ry - 2, y1: ry + ROW_H - 4 });
  }

  if (crowded) trackLabel(ctx, "Names shown for well-known genes · zoom in to see every name", 8, y - 6);
  if (hidden > 0) trackLabel(ctx, `+${hidden} more genes · zoom in to see them`, width - 260, height - 30);
  if (!placed.length && cache.loading === 0) {
    ctx.fillStyle = "#80868b";
    ctx.font = `500 13px ${FONT}`;
    ctx.textBaseline = "top";
    ctx.fillText(expert ? "No annotated genes in this region"
      : "No known genes here — much of your DNA sits between genes and helps control them", 20, y + 8);
  }
  return placed.map((p) => p.g);
}

function drawPins(ctx: Ctx, pins: GeneSummary[], y: number, X: (bp: number) => number, width: number,
  selected: number | null, hits: Hit[]) {
  const sorted = [...pins].sort((a, b) => a.start - b.start);
  const lanes: number[] = [];
  ctx.font = `600 12px ${FONT}`;
  for (const p of sorted) {
    const x = X((p.start + p.end) / 2);
    if (x < -10 || x > width + 10) continue;
    const lw = ctx.measureText(p.symbol).width + 18;
    let lane = lanes.findIndex((e) => e < x - 10);
    if (lane === -1) {
      lane = lanes.length;
      lanes.push(0);
    }
    if (lane > 5) continue;
    lanes[lane] = x + lw;
    const py = y + lane * 30;
    const color = geneColor(p.categories, p.type);
    // Stem down to the density baseline, then a map pin.
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(x, y - 26);
    ctx.lineTo(x, py);
    ctx.stroke();
    ctx.globalAlpha = 1;
    drawPinGlyph(ctx, x, py + 12, color, p.id === selected);
    ctx.fillStyle = "#202124";
    ctx.textBaseline = "middle";
    ctx.fillText(p.symbol, x + 9, py + 5);
    hits.push({ kind: "pin", gene: p, x0: x - 8, x1: x + lw, y0: py - 6, y1: py + 16 });
  }
}

function drawPinGlyph(ctx: Ctx, x: number, tipY: number, color: string, big: boolean) {
  const r = big ? 7 : 5.5;
  const cy = tipY - r * 2.1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, cy, r, Math.PI * 0.85, Math.PI * 2.15);
  ctx.lineTo(x, tipY);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(x, cy, r * 0.4, 0, Math.PI * 2);
  ctx.fill();
}

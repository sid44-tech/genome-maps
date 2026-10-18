import { useEffect, useRef, useState } from "react";
import { Chromosome, GeneSummary } from "./api";
import { STAIN, geneColor } from "./theme";
import { friendlyCount } from "./plain";
import { formatBp, shortChrom } from "./view";

const ABOUT: Record<string, string> = {
  chrX: "One of the two sex chromosomes. Most women have two X chromosomes; most men have one X and one Y.",
  chrY: "The smaller sex chromosome, usually found in men. It carries the gene that starts male development.",
  chr1: "The largest human chromosome.",
  chr21: "The smallest chromosome. Having an extra copy causes Down syndrome.",
};

interface Props {
  chromosomes: Chromosome[];
  width: number;
  height: number;
  top: number;
  pins: GeneSummary[];
  variantsPerChrom: Record<string, number> | null;
  onEnter: (chrom: string, position: number) => void;
  onSelectGene: (id: number) => void;
  expert: boolean;
}

const ZOOM_MS = 320;

/** Whole-genome overview: every chromosome as a classic banded ideogram. */
export default function KaryotypeView({ chromosomes, width, height, top, pins, variantsPerChrom, onEnter, onSelectGene, expert }: Props) {
  const [hover, setHover] = useState<{ chrom: string; pos: number; x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState<{ ox: number; oy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const chroms = chromosomes.filter((c) => c.name !== "chrM");
  // Phones get three rows of 8; wider screens two rows of 12.
  const narrow = width < 820;
  const slots = narrow ? 8 : 12;
  const rows = Array.from({ length: Math.ceil(chroms.length / slots) }, (_, i) => chroms.slice(i * slots, (i + 1) * slots));
  const maxLen = Math.max(...chroms.map((c) => c.length));
  const padTop = top + 12;
  const rowGap = narrow ? 40 : 54;
  const rowH = (height - padTop - rowGap * (rows.length - 1) - 64) / rows.length;
  const usable = width - 24 - (narrow ? 60 : 184); // keep clear of the zoom ladder on the right
  const slotW = Math.min(110, usable / slots);
  const chromW = Math.max(12, Math.min(26, slotW * 0.32));
  const left = 24 + (usable - slotW * slots) / 2;

  const geom = rows.flatMap((row, r) =>
    row.map((c, i) => {
      const h = (c.length / maxLen) * (rowH - 30);
      const x = left + i * slotW + slotW / 2 - chromW / 2;
      const y = padTop + r * (rowH + rowGap) + (rowH - 30 - h); // bottom-aligned per row
      return { c, x, y, h };
    }),
  );

  const enter = (chrom: string, pos: number, ox: number, oy: number) => {
    if (zoom) return;
    setZoom({ ox, oy });
    setTimeout(() => onEnter(chrom, pos), ZOOM_MS);
  };

  const positionAt = (g: (typeof geom)[number], clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientY - rect.top - g.y) / g.h));
    return frac * g.c.length;
  };

  useEffect(() => {
    const svg = svgRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY >= 0) return;
      const rect = svg.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // Zoom into the chromosome nearest the cursor.
      let best = geom[0];
      let bestD = Infinity;
      for (const g of geom) {
        const dx = Math.abs(x - (g.x + chromW / 2));
        const dy = y < g.y ? g.y - y : y > g.y + g.h ? y - g.y - g.h : 0;
        const d = dx + dy * 2;
        if (d < bestD) [best, bestD] = [g, d];
      }
      if (bestD < slotW) enter(best.c.name, positionAt(best, e.clientY), x, y);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  });

  const pinsByChrom = new Map<string, GeneSummary[]>();
  for (const p of pins) pinsByChrom.set(p.chrom, [...(pinsByChrom.get(p.chrom) ?? []), p]);
  const maxVariants = variantsPerChrom ? Math.max(1, ...Object.values(variantsPerChrom)) : 1;

  return (
    <div className="karyotype">
      <svg
        ref={svgRef}
        width={width}
        height={height}
        style={{
          transformOrigin: zoom ? `${zoom.ox}px ${zoom.oy}px` : undefined,
          transform: zoom ? "scale(6)" : undefined,
          opacity: zoom ? 0 : 1,
          transition: zoom ? `transform ${ZOOM_MS}ms ease-in, opacity ${ZOOM_MS}ms ease-in` : undefined,
        }}
      >
        <defs>
          {geom.map(({ c, x, y, h }) => (
            <clipPath id={`clip-${c.name}`} key={c.name}>
              <rect x={x} y={y} width={chromW} height={h} rx={chromW / 2} />
            </clipPath>
          ))}
        </defs>
        {geom.map((g) => {
          const { c, x, y, h } = g;
          const s = h / c.length;
          const isHover = hover?.chrom === c.name;
          const nVar = variantsPerChrom?.[c.name] ?? 0;
          return (
            <g
              key={c.name}
              className="karyo-chrom"
              onMouseMove={(e) => {
                const rect = svgRef.current!.getBoundingClientRect();
                setHover({ chrom: c.name, pos: positionAt(g, e.clientY), x: e.clientX - rect.left, y: e.clientY - rect.top });
              }}
              onMouseLeave={() => setHover(null)}
              onClick={(e) => {
                const rect = svgRef.current!.getBoundingClientRect();
                enter(c.name, positionAt(g, e.clientY), e.clientX - rect.left, e.clientY - rect.top);
              }}
            >
              <rect x={x - slotW * 0.3} y={y - 30} width={chromW + slotW * 0.6} height={h + 64} fill="transparent" />
              {isHover && (
                <rect x={x - 6} y={y - 6} width={chromW + 12} height={h + 12} rx={chromW / 2 + 6} className="karyo-halo" />
              )}
              <g clipPath={`url(#clip-${c.name})`}>
                <rect x={x} y={y} width={chromW} height={h} fill={STAIN.gneg} />
                {c.bands.map(([bs, be, , stain], i) =>
                  stain === "acen" ? (
                    <rect key={i} x={x + chromW * 0.22} y={y + bs * s} width={chromW * 0.56} height={(be - bs) * s + 0.3} fill={STAIN.acen} />
                  ) : stain === "gneg" ? null : (
                    <rect key={i} x={x} y={y + bs * s} width={chromW} height={(be - bs) * s + 0.3} fill={STAIN[stain] ?? STAIN.gneg} />
                  ),
                )}
              </g>
              {/* centromere pinch: cut-outs on both sides */}
              {centromere(c).map(([cs, ce], i) => (
                <g key={i}>
                  <path d={pinch(x, y + cs * s, (ce - cs) * s, chromW, -1)} fill="var(--bg)" />
                  <path d={pinch(x + chromW, y + cs * s, (ce - cs) * s, chromW, 1)} fill="var(--bg)" />
                </g>
              ))}
              <rect x={x} y={y} width={chromW} height={h} rx={chromW / 2} fill="none" stroke={isHover ? "#1a73e8" : "#9aa0a6"} strokeWidth={isHover ? 1.5 : 1} />
              <text x={x + chromW / 2} y={y + h + 20} className="karyo-label">
                {shortChrom(c.name)}
              </text>
              {nVar > 0 && (
                <rect
                  x={x + chromW / 2 - 14}
                  y={y + h + 28}
                  width={28 * Math.max(0.12, nVar / maxVariants)}
                  height={4}
                  rx={2}
                  fill="#f29900"
                >
                  <title>{nVar.toLocaleString()} differences from reference</title>
                </rect>
              )}
              {(pinsByChrom.get(c.name) ?? []).map((p) => {
                const py = y + ((p.start + p.end) / 2) * s;
                return (
                  <g
                    key={p.id}
                    className="karyo-pin"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectGene(p.id);
                    }}
                  >
                    <line x1={x + chromW} x2={x + chromW + 9} y1={py} y2={py} stroke={geneColor(p.categories, p.type)} strokeWidth={1.5} />
                    <circle cx={x + chromW + 12} cy={py} r={3.6} fill={geneColor(p.categories, p.type)} stroke="#fff" strokeWidth={1} />
                    <title>{p.symbol} — {p.description}</title>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      {hover && !zoom && (() => {
        const c = chromosomes.find((x) => x.name === hover.chrom)!;
        const nVar = variantsPerChrom?.[c.name];
        return (
          <div className="tooltip" style={{ left: Math.min(hover.x + 16, width - 280), top: hover.y + 12 }}>
            <b>Chromosome {shortChrom(c.name)}</b>
            {expert ? (
              <div className="muted">{bandAt(c, hover.pos)} · {formatBp(hover.pos)} · {formatBp(c.length)} total</div>
            ) : (
              <div>{friendlyCount(c.length)} DNA letters · about {c.geneCount.toLocaleString()} genes</div>
            )}
            {!expert && ABOUT[c.name] && <div className="muted">{ABOUT[c.name]}</div>}
            {nVar ? <div className="muted">You differ from the reference at {nVar.toLocaleString()} spots tested here</div> : null}
            <div className="muted">Click or scroll to zoom in</div>
          </div>
        );
      })()}
    </div>
  );
}

function centromere(c: Chromosome): [number, number][] {
  const acen = c.bands.filter((b) => b[3] === "acen");
  if (!acen.length) return [];
  return [[acen[0][0], acen[acen.length - 1][1]]];
}

/** A small triangular notch at the centromere, drawn in the background color. */
function pinch(x: number, y: number, h: number, w: number, side: -1 | 1): string {
  const depth = w * 0.24 * -side;
  return `M ${x} ${y} L ${x + depth} ${y + h / 2} L ${x} ${y + h} Z`;
}

function bandAt(c: Chromosome, pos: number): string {
  const b = c.bands.find(([s, e]) => pos >= s && pos < e);
  return b ? `${shortChrom(c.name)}${b[2]}` : shortChrom(c.name);
}

import { Chromosome, Gene } from "./api";
import { LEVELS, LevelId, useStoredFlag } from "./plain";
import { BASE, CATEGORY_COLORS, VARIANT } from "./theme";
import { LOD, View, shortChrom, viewRange } from "./view";

/** Which zoom "stop" the current view corresponds to. */
export function currentLevel(view: View | null, width: number, centerGene: Gene | null): LevelId {
  if (!view) return "genome";
  if (view.bpp <= LOD.letters) return "letters";
  const span = width * view.bpp;
  if (centerGene && view.bpp <= LOD.genes && span <= 3.5 * (centerGene.end - centerGene.start)) return "gene";
  if (view.bpp <= LOD.genes) return "neighborhood";
  return "chromosome";
}

function bandAt(c: Chromosome, pos: number) {
  const b = c.bands.find(([s, e]) => pos >= s && pos < e);
  return b ? `${shortChrom(c.name)}${b[2]}` : null;
}

export function Breadcrumb({ level, chromosome, view, width, centerGene, expert, onGo }: {
  level: LevelId;
  chromosome: Chromosome | null;
  view: View | null;
  width: number;
  centerGene: Gene | null;
  expert: boolean;
  onGo: (level: LevelId) => void;
}) {
  const idx = LEVELS.findIndex((l) => l.id === level);
  const crumbs: { id: LevelId; label: string }[] = [{ id: "genome", label: "All chromosomes" }];
  if (chromosome && view) {
    crumbs.push({ id: "chromosome", label: `Chromosome ${shortChrom(chromosome.name)}` });
    if (idx >= 2) {
      const band = bandAt(chromosome, view.center);
      crumbs.push({ id: "neighborhood", label: expert && band ? `Region ${band}` : "Neighborhood" });
    }
    if (idx >= 3 && centerGene) crumbs.push({ id: "gene", label: `${centerGene.symbol} gene` });
    if (idx >= 4) {
      const [s] = viewRange(view, width);
      crumbs.push({ id: "letters", label: expert ? `${Math.round(Math.max(0, s) + 1).toLocaleString()}…` : "DNA letters" });
    }
  }
  return (
    <nav className="breadcrumb" aria-label="Where you are">
      {crumbs.map((c, i) => (
        <span key={c.id} className="crumb-wrap">
          {i > 0 && <span className="crumb-sep">›</span>}
          <button className={`crumb ${i === crumbs.length - 1 ? "current" : ""}`} onClick={() => onGo(c.id)}>
            {c.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

/** Vertical zoom ladder, like the city / street / building stops on a map. */
export function ZoomLadder({ level, canDive, onGo, onZoom }: {
  level: LevelId;
  canDive: boolean;
  onGo: (level: LevelId) => void;
  onZoom: (factor: number) => void;
}) {
  const idx = LEVELS.findIndex((l) => l.id === level);
  return (
    <div className="ladder" role="group" aria-label="Zoom">
      <button className="ladder-pm" onClick={() => onZoom(0.5)} aria-label="Zoom in" title="Zoom in (+)">+</button>
      <ol>
        {[...LEVELS].reverse().map((l) => {
          const i = LEVELS.indexOf(l);
          const disabled = !canDive && i > 0;
          return (
            <li key={l.id}>
              <button
                className={`ladder-stop ${i === idx ? "on" : ""} ${i < idx ? "above" : ""}`}
                disabled={disabled}
                onClick={() => onGo(l.id)}
                title={disabled ? "Pick a chromosome first" : l.hint}
              >
                <span className="ladder-dot" />
                <span className="ladder-label">{l.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <button className="ladder-pm" onClick={() => onZoom(2)} aria-label="Zoom out" title="Zoom out (−)">−</button>
    </div>
  );
}

const KEY_GENES: [string, string][] = [
  ["#d93025", "Linked to a health condition"],
  [CATEGORY_COLORS.find(([c]) => c === "appearance")![1], "Physical appearance"],
  [CATEGORY_COLORS.find(([c]) => c === "pharmacogenomics")![1], "Medicine response"],
  ["#1a73e8", "Other genes that make proteins"],
  ["#12857a", "Genes that make RNA"],
];

export function MapKey({ level, hasUpload, expert, setExpert, defaultOpen }: {
  level: LevelId;
  hasUpload: boolean;
  expert: boolean;
  setExpert: (v: boolean) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useStoredFlag("mapKeyOpen", defaultOpen);
  return (
    <div className="map-key">
      <div className="map-key-bar">
        <button className="map-key-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          Map key <span className="caret">{open ? "▾" : "▸"}</span>
        </button>
        <div className="segmented" role="radiogroup" aria-label="Level of detail">
          <button role="radio" aria-checked={!expert} className={!expert ? "on" : ""} onClick={() => setExpert(false)}>
            Simple
          </button>
          <button role="radio" aria-checked={expert} className={expert ? "on" : ""} onClick={() => setExpert(true)}
            title="Show coordinates, chromosome bands and scientific terms">
            Detailed
          </button>
        </div>
      </div>
      {open && (
        <div className="map-key-body">
          {level === "letters" ? (
            <>
              <div className="key-title">The 4 DNA letters</div>
              <div className="key-row">
                {(["A", "C", "G", "T"] as const).map((b) => (
                  <span key={b} className="key-base" style={{ background: BASE[b] }}>{b}</span>
                ))}
              </div>
              <p className="key-note">Every instruction in your body is spelled with just these four letters.</p>
            </>
          ) : level === "genome" ? (
            <>
              <div className="key-title">Chromosomes</div>
              <p className="key-note">Light and dark stripes are bands that help scientists find their way. The red pinch is the centromere, where the two halves join.</p>
            </>
          ) : (
            <>
              <div className="key-title">Genes</div>
              {KEY_GENES.map(([color, label]) => (
                <div key={label} className="key-item"><span className="key-swatch" style={{ background: color }} />{label}</div>
              ))}
            </>
          )}
          {hasUpload && level !== "genome" && (
            <>
              <div className="key-title">Your DNA</div>
              <div className="key-item"><span className="key-swatch" style={{ background: VARIANT.het }} />One copy differs</div>
              <div className="key-item"><span className="key-swatch" style={{ background: VARIANT.homAlt }} />Both copies differ</div>
              <div className="key-item"><span className="key-diamond" />Health-related finding</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

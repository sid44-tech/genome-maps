import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChromosomeView from "./ChromosomeView";
import Guide from "./Guide";
import { Breadcrumb, MapKey, ZoomLadder, currentLevel } from "./Navigator";
import { LevelId, useStoredFlag } from "./plain";
import KaryotypeView from "./KaryotypeView";
import { DnaPanel, GenePanel, ResultsPanel } from "./Panels";
import SearchBox from "./SearchBox";
import { Gene, GeneDetail, GeneSummary, GenomeInfo, SearchResult, Upload, api, setDataVersion } from "./api";
import { categoryColor } from "./theme";
import { MIN_BPP, View, clampView, fitRange, hashToRange, maxBpp, viewToHash } from "./view";

const TOP = 76;
const PANEL_W = 424;

type Panel =
  | { kind: "none" }
  | { kind: "results"; title: string; total: number; items: GeneSummary[] }
  | { kind: "gene"; gene: GeneDetail }
  | { kind: "dna" };

function useWindowSize() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return size;
}

export default function App() {
  const [genome, setGenome] = useState<GenomeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setViewState] = useState<View | null>(null); // null = karyotype
  const [panel, setPanel] = useState<Panel>({ kind: "none" });
  const [pins, setPins] = useState<GeneSummary[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [activeUpload, setActiveUpload] = useState<string | null>(null);
  const [showSensitive, setShowSensitiveState] = useState(() => {
    try {
      return localStorage.getItem("showSensitive") === "1";
    } catch {
      return false;
    }
  });
  const setShowSensitive = (on: boolean) => {
    setShowSensitiveState(on);
    try {
      localStorage.setItem("showSensitive", on ? "1" : "0");
    } catch {
      /* storage unavailable: setting lasts for this visit only */
    }
  };
  const { w, h } = useWindowSize();
  const [expert, setExpert] = useStoredFlag("expert", false);
  const [welcomed, setWelcomed] = useStoredFlag("welcomed", false);
  const [guideOpen, setGuideOpen] = useState(!welcomed);
  const [centerGene, setCenterGene] = useState<Gene | null>(null);
  const closeGuide = useCallback(() => {
    setGuideOpen(false);
    setWelcomed(true);
  }, [setWelcomed]);

  const narrow = w < 820;
  const panelOpen = panel.kind !== "none";
  const mapLeft = panelOpen && !narrow ? PANEL_W : 0;
  const mapW = w - mapLeft;

  useEffect(() => {
    api.genome().then((g) => {
      setDataVersion(g.dataVersion);
      setGenome(g);
    }).catch((e) => setError(`Could not reach the API: ${e.message}`));
  }, []);

  // Upload summaries include sensitive findings only when the viewer has opted in.
  useEffect(() => {
    api.uploads(showSensitive).then((u) => {
      setUploads(u);
      setActiveUpload((cur) => (cur && u.some((x) => x.id === cur) ? cur : u[0]?.id ?? null));
    }).catch(() => {});
  }, [showSensitive]);

  const chromosome = useMemo(
    () => (genome && view ? genome.chromosomes.find((c) => c.name === view.chrom) ?? null : null),
    [genome, view],
  );

  // ---- view animation --------------------------------------------------------

  const anim = useRef(0);
  const setView = useCallback((v: View | null) => {
    cancelAnimationFrame(anim.current);
    setViewState(v);
  }, []);

  const viewRef = useRef(view);
  viewRef.current = view;
  const animateTo = useCallback((target: View) => {
    cancelAnimationFrame(anim.current);
    const from = viewRef.current;
    if (!from || from.chrom !== target.chrom) {
      setViewState(target);
      return;
    }
    const t0 = performance.now();
    // Long jumps zoom out and back in, like a map "fly to".
    const travel = Math.abs(target.center - from.center) / Math.max(from.bpp, target.bpp) / mapW;
    const dur = Math.min(1100, 320 + travel * 120);
    const peak = travel > 1.5 ? Math.log(Math.max(from.bpp, target.bpp) * travel * 0.6) : -Infinity;
    const l0 = Math.log(from.bpp), l1 = Math.log(target.bpp);
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / dur);
      const e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
      let lb = l0 + (l1 - l0) * e;
      if (peak > -Infinity) lb = Math.max(lb, peak - (peak - Math.max(l0, l1)) * (2 * e - 1) ** 2);
      setViewState({ chrom: target.chrom, center: from.center + (target.center - from.center) * e, bpp: Math.exp(lb) });
      if (t < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  }, [mapW]);

  const goTo = useCallback(
    (chrom: string, start: number, end: number, pad = 1.3) => {
      const c = genome?.chromosomes.find((x) => x.name === chrom);
      if (!c) return;
      const target = clampView(fitRange(chrom, start, Math.min(end, c.length), mapW, pad), c.length, mapW);
      if (viewRef.current?.chrom === chrom) animateTo(target);
      else setView(target);
    },
    [genome, mapW, animateTo, setView],
  );

  // ---- URL hash <-> view -------------------------------------------------------

  const hashApplied = useRef(false);
  useEffect(() => {
    if (!genome) return;
    const apply = () => {
      const r = hashToRange(window.location.hash);
      if (!r) return setView(null);
      const c = genome.chromosomes.find((x) => x.name === r.chrom);
      if (c) setView(clampView(fitRange(c.name, r.start, Math.min(r.end, c.length), mapW, 1), c.length, mapW));
    };
    if (!hashApplied.current) {
      hashApplied.current = true;
      apply();
    }
    const onHash = () => {
      if (window.location.hash !== viewToHash(viewRef.current, mapW)) apply();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [genome, mapW, setView]);

  useEffect(() => {
    const t = setTimeout(() => {
      const hash = viewToHash(view, mapW);
      if (hash !== window.location.hash) history.replaceState(null, "", hash || window.location.pathname);
    }, 200);
    return () => clearTimeout(t);
  }, [view, mapW]);

  // ---- actions ---------------------------------------------------------------

  const selectGene = useCallback(async (id: number, zoom = false) => {
    const gene = await api.gene(id);
    setPanel({ kind: "gene", gene });
    if (zoom) goTo(gene.chrom, gene.start, gene.end, 1.6);
  }, [goTo]);

  const showResults = async (title: string, q: string, cat?: string) => {
    const r = await api.search(q, cat, 300);
    const genes = r.results.filter((x): x is SearchResult & { kind: "gene" } => x.kind === "gene");
    setPins(genes);
    setPanel({ kind: "results", title, total: r.total, items: genes });
    return genes;
  };

  const onPick = (r: SearchResult) => {
    if (r.kind === "locus") {
      if (r.start === 0 && r.end >= (genome?.chromosomes.find((c) => c.name === r.chrom)?.length ?? 0)) {
        goTo(r.chrom, 0, r.end, 1);
      } else goTo(r.chrom, r.start, r.end, 1);
      return;
    }
    setQuery(r.symbol);
    setPins([r]);
    selectGene(r.id, true);
  };

  const onSubmit = async (q: string) => {
    setCategory(null);
    const r = await api.search(q, undefined, 300);
    if (r.results.length === 1 || (r.results[0]?.kind === "gene" && r.results[0].symbol.toLowerCase() === q.toLowerCase())) {
      onPick(r.results[0]);
      return;
    }
    if (r.results[0]?.kind === "locus") return onPick(r.results[0]);
    await showResults(`Results for “${q}”`, q);
  };

  const toggleCategory = async (id: string, label: string) => {
    if (category === id) {
      setCategory(null);
      setPins([]);
      setPanel({ kind: "none" });
      return;
    }
    setCategory(id);
    setQuery("");
    await showResults(label, "", id);
  };

  const zoomBy = (factor: number) => {
    if (!view || !chromosome) {
      if (factor < 1 && genome) goTo("chr1", 0, genome.chromosomes[0].length, 1);
      return;
    }
    if (factor > 1 && view.bpp >= maxBpp(chromosome.length, mapW) * 0.999) return setView(null);
    animateTo(clampView({ ...view, bpp: view.bpp * factor }, chromosome.length, mapW));
  };

  const level = currentLevel(view, mapW, centerGene);

  /** Jump to a zoom "stop" around what's currently in the middle of the screen. */
  const goLevel = (target: LevelId) => {
    if (target === "genome") return setView(null);
    if (!view || !chromosome) return;
    const len = chromosome.length;
    const at = (bpp: number) => clampView({ ...view, bpp }, len, mapW);
    if (target === "chromosome") animateTo(at(maxBpp(len, mapW)));
    else if (target === "neighborhood") animateTo(at(3e6 / mapW));
    else if (target === "gene") {
      if (centerGene) goTo(centerGene.chrom, centerGene.start, centerGene.end, 1.4);
      else animateTo(at(1e5 / mapW));
    } else animateTo(at(MIN_BPP * 1.7));
  };

  const upload = uploads.find((u) => u.id === activeUpload) ?? null;
  const clinicalHere = useMemo(
    () => (upload?.clinical?.findings ?? []).filter((f) => f.chrom === view?.chrom),
    [upload, view?.chrom],
  );
  const visiblePins = view ? pins.filter((p) => p.chrom === view.chrom) : pins;

  if (error) return <div className="fatal">{error}<p className="muted">Start the backend with <code>make backend</code>.</p></div>;
  if (!genome) return <div className="fatal"><span className="spinner" /> Loading genome…</div>;

  return (
    <div className={`app ${narrow ? "narrow" : ""}`}>
      <div className="map" style={{ left: mapLeft, width: mapW, height: h }}>
        {view && chromosome ? (
          <ChromosomeView
            key={chromosome.name}
            chromosome={chromosome}
            view={view}
            width={mapW}
            height={h}
            top={TOP + (narrow ? 44 : 0)}
            setView={setView}
            animateTo={animateTo}
            uploadId={activeUpload}
            showSensitive={showSensitive}
            clinical={clinicalHere}
            selectedGeneId={panel.kind === "gene" ? panel.gene.id : null}
            pins={visiblePins}
            onSelectGene={(id) => selectGene(id)}
            onExit={() => setView(null)}
            expert={expert}
            onCenterGene={setCenterGene}
          />
        ) : (
          <KaryotypeView
            chromosomes={genome.chromosomes}
            width={mapW}
            height={h}
            top={TOP + (narrow ? 44 + 44 : 0) + 64}
            pins={pins}
            variantsPerChrom={upload?.variantsPerChrom ?? null}
            expert={expert}
            onEnter={(chrom, pos) => {
              const c = genome.chromosomes.find((x) => x.name === chrom)!;
              setView(clampView({ chrom, center: pos, bpp: maxBpp(c.length, mapW) }, c.length, mapW));
            }}
            onSelectGene={(id) => selectGene(id, true)}
          />
        )}
      </div>

      <div className="crumb-bar" style={{ left: mapLeft + 16, top: TOP + (narrow ? 50 : 4) }}>
        <Breadcrumb level={level} chromosome={chromosome} view={view} width={mapW} centerGene={centerGene}
          expert={expert} onGo={goLevel} />
      </div>

      <div className="topbar" style={{ width: narrow ? w - 32 - 100 : undefined }}>
        <SearchBox
          value={query}
          setValue={setQuery}
          onPick={onPick}
          onSubmit={onSubmit}
          onClear={() => {
            setPins([]);
            setCategory(null);
            if (panel.kind === "results") setPanel({ kind: "none" });
          }}
        />
      </div>

      <div className="chips" style={narrow ? { left: 16, right: 16, top: 72 } : { left: PANEL_W + 8, right: 196 }}>
        {genome.categories.map((c) => (
          <button
            key={c.id}
            className={`chip ${category === c.id ? "on" : ""}`}
            style={{ "--chip": categoryColor(c.id) } as React.CSSProperties}
            onClick={() => toggleCategory(c.id, c.label)}
          >
            <span className="chip-dot" />
            {c.label}
          </button>
        ))}
      </div>

      <button className="help-btn" onClick={() => setGuideOpen(true)} aria-label="Help and glossary" title="Help">?</button>
      <button className={`dna-btn ${upload ? "on" : ""}`} onClick={() => setPanel(panel.kind === "dna" ? { kind: "none" } : { kind: "dna" })}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
          <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M7 3c0 6 10 6 10 12s-10 3-10 6M17 3c0 6-10 6-10 12s10 3 10 6M8 7h8M8 17h8" />
        </svg>
        <span className="dna-btn-label">Your DNA</span>
      </button>

      {panelOpen && (
        <div className="panel-wrap" style={narrow ? { top: 120, left: 8, right: 8, width: "auto" } : undefined}>
          {panel.kind === "results" && (
            <ResultsPanel
              title={panel.title}
              total={panel.total}
              items={panel.items}
              expert={expert}
              onPick={(g) => selectGene(g.id, true)}
              onClose={() => {
                setPanel({ kind: "none" });
                setPins([]);
                setCategory(null);
              }}
            />
          )}
          {panel.kind === "gene" && (
            <GenePanel
              gene={panel.gene}
              upload={upload}
              expert={expert}
              showSensitive={showSensitive}
              onClose={() => setPanel({ kind: "none" })}
              onZoom={() => goTo(panel.gene.chrom, panel.gene.start, panel.gene.end, 1.6)}
            />
          )}
          {panel.kind === "dna" && (
            <DnaPanel
              uploads={uploads}
              expert={expert}
              activeId={activeUpload}
              setActiveId={setActiveUpload}
              showSensitive={showSensitive}
              setShowSensitive={setShowSensitive}
              onJumpPosition={(chrom, pos) => goTo(chrom, pos - 30, pos + 30, 1)}
              onUploaded={(u) => {
                setUploads((list) => [u, ...list]);
                setActiveUpload(u.id);
              }}
              onDeleted={(id) => {
                setUploads((list) => list.filter((u) => u.id !== id));
                if (activeUpload === id) setActiveUpload(null);
              }}
              onJumpGene={async (symbol) => {
                const r = await api.search(symbol, undefined, 1);
                if (r.results[0]) onPick(r.results[0]);
              }}
              onClose={() => setPanel({ kind: "none" })}
            />
          )}
        </div>
      )}

      <div className="ladder-wrap">
        <ZoomLadder level={level} canDive={!!view} onGo={goLevel} onZoom={zoomBy} />
      </div>
      {view && (
        <div className="map-key-wrap" style={{ left: mapLeft + 16, bottom: 56 }}>
          <MapKey level={level} hasUpload={!!upload} expert={expert} setExpert={setExpert} defaultOpen={!narrow} />
        </div>
      )}
      {!view && (
        <div className="hint" style={{ left: mapLeft + mapW / 2, top: TOP + (narrow ? 96 : 50) }}>
          {expert
            ? `Human genome · ${genome.assembly} · click a chromosome or scroll to zoom in`
            : narrow
              ? "Your 23 pairs of chromosomes. Tap one to zoom in."
              : "Your DNA is split into 23 pairs of chromosomes — here's one of each. Click any chromosome to zoom in."}
        </div>
      )}
      {guideOpen && (
        <Guide
          onClose={closeGuide}
          onExample={async () => {
            closeGuide();
            const r = await api.search("HERC2", undefined, 1);
            if (r.results[0]) onPick(r.results[0]);
          }}
          onAddDna={() => {
            closeGuide();
            setPanel({ kind: "dna" });
          }}
        />
      )}
    </div>
  );
}

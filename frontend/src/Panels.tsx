import { useEffect, useRef, useState } from "react";
import { ClinicalFinding, GeneDetail, GeneSummary, Upload, Variant, api } from "./api";
import {
  CLIN_PLAIN, evidenceLabel, findingTitle, howCommon, letters, tidyName, whatItMeans,
} from "./plain";
import { CLIN, categoryColor, formatAf, geneColor } from "./theme";
import { formatBp, formatPos, shortChrom } from "./view";

const FORMAT_NAMES: Record<string, string> = {
  "23andme": "23andMe", ancestry: "AncestryDNA", csv: "MyHeritage / FamilyTreeDNA", vcf: "VCF",
};
const CATEGORY_NAMES: Record<string, string> = {
  appearance: "Appearance", senses: "Senses", nutrition: "Diet", pharmacogenomics: "Medicines",
  fitness: "Fitness & sleep", "blood-immunity": "Blood & immunity", disease: "Health", cancer: "Cancer",
  cardiovascular: "Heart", neurological: "Brain & nerves", metabolic: "Metabolism", "vision-hearing": "Vision & hearing",
};

/** First sentence of a paragraph, for compact summaries. */
const firstSentence = (s: string) => (s.match(/^.+?[.!?](\s|$)/)?.[0] ?? s).trim();

// ---- search results ---------------------------------------------------------

export function ResultsPanel({ title, total, items, expert, onPick, onClose }: {
  title: string;
  total: number;
  items: GeneSummary[];
  expert: boolean;
  onPick: (g: GeneSummary) => void;
  onClose: () => void;
}) {
  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>{title}</h2>
          <p className="muted">
            {total.toLocaleString()} gene{total === 1 ? "" : "s"}
            {total > items.length ? ` · showing ${items.length}` : ""} · marked with pins on the map
          </p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
      </header>
      <ul className="result-list">
        {items.map((g) => (
          <li key={g.id} onClick={() => onPick(g)}>
            <span className="sugg-dot" style={{ background: geneColor(g.categories, g.type) }} />
            <div>
              <div>
                <b>{g.symbol}</b>{" "}
                <span className="muted small">
                  {expert ? `chr${shortChrom(g.chrom)}:${formatPos(g.start + 1)}` : `Chromosome ${shortChrom(g.chrom)}`}
                </span>
              </div>
              <div className="muted small clamp2">{expert ? g.description : g.blurb ?? g.description}</div>
            </div>
          </li>
        ))}
        {!items.length && <li className="muted">No genes matched.</li>}
      </ul>
    </section>
  );
}

// ---- gene details -----------------------------------------------------------

export function GenePanel({ gene, upload, expert, showSensitive, onClose, onZoom }: {
  gene: GeneDetail;
  upload: Upload | null;
  expert: boolean;
  showSensitive: boolean;
  onClose: () => void;
  onZoom: () => void;
}) {
  const [variants, setVariants] = useState<Variant[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [readMore, setReadMore] = useState(false);

  useEffect(() => {
    setVariants(null);
    setReadMore(false);
    if (!upload) return;
    fetch(`/api/uploads/${upload.id}/variants?chrom=${gene.chrom}&start=${gene.start}&end=${gene.end}${showSensitive ? "&sensitive=true" : ""}`)
      .then((r) => r.json())
      .then((d) => setVariants(d.variants))
      .catch(() => setVariants([]));
  }, [gene, upload, showSensitive]);

  const findings = upload?.findings.filter((f) => f.gene === gene.symbol) ?? [];
  const health = upload?.clinical?.findings.filter((f) => f.gene === gene.symbol) ?? [];
  const plainConditions = gene.plain.conditions;
  const diseases = showAll ? gene.diseases : gene.diseases.slice(0, 6);
  const coding = gene.cdsEnd > gene.cdsStart;
  const friendlyCats = gene.categories.filter((c) => CATEGORY_NAMES[c]);

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2 className="gene-title" style={{ color: geneColor(gene.categories, gene.type) }}>
            {gene.symbol} <span className="gene-word">gene</span>
          </h2>
          <p className="muted">{gene.traits[0]?.trait ?? tidyName(gene.description)}</p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
      </header>

      {friendlyCats.length > 0 && (
        <div className="chip-row">
          {friendlyCats.map((c) => (
            <span key={c} className="tag" style={{ borderColor: categoryColor(c), color: categoryColor(c) }}>
              {CATEGORY_NAMES[c]}
            </span>
          ))}
        </div>
      )}

      <button className="primary-btn" onClick={onZoom}>Zoom to this gene</button>

      <h3>What it does</h3>
      <p>{gene.plain.summary}</p>
      {readMore && gene.plain.more.map((p, i) => <p key={i}>{p}</p>)}
      {gene.plain.more.length > 0 && (
        <button className="link-btn" onClick={() => setReadMore(!readMore)}>{readMore ? "Show less" : "Read more"}</button>
      )}

      {gene.traits.length > 0 && (
        <>
          <h3>Known to influence</h3>
          <ul className="bullets">{gene.traits.map((t, i) => <li key={i}>{t.trait}</li>)}</ul>
        </>
      )}

      {plainConditions.length > 0 ? (
        <>
          <h3>Health conditions linked to this gene</h3>
          {plainConditions.map((c) => (
            <details key={c.name} className="condition">
              <summary>{c.name}</summary>
              <p>{c.summary}</p>
              <a href={c.url} target="_blank" rel="noreferrer">Read more on MedlinePlus</a>
            </details>
          ))}
        </>
      ) : gene.diseases.length > 0 && (
        <>
          <h3>Health conditions linked to this gene</h3>
          <ul className="bullets">{diseases.map((d) => <li key={d}>{tidyName(d)}</li>)}</ul>
          {gene.diseases.length > 6 && (
            <button className="link-btn" onClick={() => setShowAll(!showAll)}>
              {showAll ? "Show fewer" : `Show all ${gene.diseases.length}`}
            </button>
          )}
        </>
      )}

      {upload && (
        <>
          <h3>In your DNA</h3>
          {findings.map((f) => (
            <div className="finding" key={f.rsid}>
              <b>{f.trait}</b>
              <div>{f.interpretation}</div>
            </div>
          ))}
          {health.map((f) => <FindingSummary key={f.rsid + f.alt} f={f} />)}
          {variants === null ? (
            <p className="muted">Loading…</p>
          ) : variants.length === 0 ? (
            <p className="muted">Your test didn't find any differences from the reference genome in this gene.</p>
          ) : (
            <p>
              Your DNA differs from the reference genome at <b>{variants.length}</b> spot{variants.length === 1 ? "" : "s"}{" "}
              your test checked in this gene.
              {!health.length && " None of them are known to affect health."}
            </p>
          )}
          {expert && variants && variants.length > 0 && <VariantTable variants={variants} />}
        </>
      )}

      <details className="tech" open={expert}>
        <summary>Technical details</summary>
        <dl className="facts">
          <dt>Full name</dt>
          <dd>{gene.description}</dd>
          <dt>Location</dt>
          <dd>
            chr{shortChrom(gene.chrom)}:{formatPos(gene.start + 1)}–{formatPos(gene.end)} ({gene.strand === "+" ? "forward" : "reverse"} strand)
          </dd>
          <dt>Size</dt>
          <dd>
            {formatBp(gene.end - gene.start)} ({letters(gene.end - gene.start)}) · {gene.exons.length} exon{gene.exons.length === 1 ? "" : "s"}
            {coding && ` · ${Math.floor(codingLength(gene) / 3).toLocaleString()} amino acids`}
          </dd>
          <dt>Gene type</dt>
          <dd>{gene.type}</dd>
          <dt>Transcript</dt>
          <dd>{gene.transcript}</dd>
          {gene.synonyms.length > 0 && (
            <>
              <dt>Other names</dt>
              <dd>{gene.synonyms.slice(0, 8).join(", ")}</dd>
            </>
          )}
        </dl>
        {expert && gene.diseases.length > 0 && plainConditions.length > 0 && (
          <>
            <h4>ClinVar conditions</h4>
            <ul className="bullets small">{gene.diseases.slice(0, 20).map((d) => <li key={d}>{d}</li>)}</ul>
          </>
        )}
      </details>

      <h3>Learn more</h3>
      <div className="links">
        {gene.plain.url && <a href={gene.plain.url} target="_blank" rel="noreferrer">MedlinePlus (easy to read)</a>}
        {gene.geneId && <a href={`https://www.ncbi.nlm.nih.gov/gene/${gene.geneId}`} target="_blank" rel="noreferrer">NCBI Gene</a>}
        {gene.mim && <a href={`https://omim.org/entry/${gene.mim}`} target="_blank" rel="noreferrer">OMIM</a>}
        <a href={`https://www.ncbi.nlm.nih.gov/clinvar/?term=${encodeURIComponent(gene.symbol)}%5Bgene%5D`} target="_blank" rel="noreferrer">ClinVar</a>
        <a href={`https://www.genecards.org/cgi-bin/carddisp.pl?gene=${encodeURIComponent(gene.symbol)}`} target="_blank" rel="noreferrer">GeneCards</a>
      </div>
    </section>
  );
}

function VariantTable({ variants }: { variants: Variant[] }) {
  return (
    <table className="variant-table">
      <thead>
        <tr><th>SNP</th><th>Position</th><th>Ref</th><th>You</th><th>ClinVar</th></tr>
      </thead>
      <tbody>
        {variants.slice(0, 50).map((v) => (
          <tr key={v.pos}>
            <td>{v.rsid}</td>
            <td>{formatPos(v.pos)}</td>
            <td><code>{v.ref}</code></td>
            <td><code className={v.zygosity === 2 ? "hom" : "het"}>{v.genotype}</code></td>
            <td>
              {v.clinvar ? (
                <span className="clin-badge" style={{ background: CLIN[v.clinvar.class].color }} title={v.clinvar.significance}>
                  {CLIN[v.clinvar.class].label.split(" /")[0]}
                </span>
              ) : v.hiddenSensitive ? <span className="muted small">hidden</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FindingSummary({ f }: { f: ClinicalFinding }) {
  const meta = CLIN_PLAIN[f.class];
  return (
    <div className="finding clin" style={{ borderLeftColor: meta.color }}>
      <span className="clin-badge" style={{ background: meta.color }}>{meta.badge}</span>
      <div className="clin-condition">{findingTitle(f)}</div>
      <div className="small">{whatItMeans(f)}</div>
    </div>
  );
}

function codingLength(g: GeneDetail) {
  let n = 0;
  for (const [s, e] of g.exons) n += Math.max(0, Math.min(e, g.cdsEnd) - Math.max(s, g.cdsStart));
  return n;
}

// ---- personal DNA -----------------------------------------------------------

export function DnaPanel({ uploads, expert, activeId, setActiveId, showSensitive, setShowSensitive, onUploaded,
  onDeleted, onJumpGene, onJumpPosition, onClose }: {
  uploads: Upload[];
  expert: boolean;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  showSensitive: boolean;
  setShowSensitive: (on: boolean) => void;
  onJumpPosition: (chrom: string, pos: number) => void;
  onUploaded: (u: Upload) => void;
  onDeleted: (id: string) => void;
  onJumpGene: (symbol: string) => void;
  onClose: () => void;
}) {
  const active = uploads.find((u) => u.id === activeId) ?? null;
  const differ = active ? (active.counts.het ?? 0) + (active.counts.hom_alt ?? 0) : 0;

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>Your DNA</h2>
          <p className="muted">
            {active ? "What your DNA test results show" : "See what makes your DNA yours"}
          </p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
      </header>

      {!active && (
        <>
          <p>
            If you've taken a DNA test from a company like 23andMe or AncestryDNA, you can download your “raw data”
            file and add it here. We'll compare it with the <b>reference genome</b> — a standard human DNA sequence
            scientists use as a yardstick — and show you where yours is different.
          </p>
          <p className="muted small">
            Everyone differs from the reference in millions of places. Almost all of these differences are harmless;
            they're part of what makes each person unique.
          </p>
          <details className="howto">
            <summary>How do I get my raw data file?</summary>
            <p>
              Sign in to your DNA testing company's website and look in your account or settings for an option such
              as <i>“Download raw data”</i> or <i>“Download DNA data.”</i> The company will email you a file (often a
              .zip). You can add that file here as-is.
            </p>
          </details>
          <Uploader expert={expert} onUploaded={onUploaded} />
        </>
      )}

      {active && (
        <>
          <div className="dna-summary">
            <p>
              Your test checked <b>{(active.counts.called ?? 0).toLocaleString()}</b> spots in your DNA. At{" "}
              <b>{differ.toLocaleString()}</b> of them you're different from the reference genome — completely normal.
            </p>
            <div className="stats">
              <Stat label="One of your two copies differs" value={active.counts.het ?? 0} color="#f29900" />
              <Stat label="Both copies differ" value={active.counts.hom_alt ?? 0} color="#d93025" />
            </div>
            <p className="muted small">Differences show up as orange and red marks on the “Your DNA” strip of the map.</p>
          </div>

          {active.clinical && (
            <ClinicalSection
              clinical={active.clinical}
              expert={expert}
              showSensitive={showSensitive}
              setShowSensitive={setShowSensitive}
              onJump={onJumpPosition}
            />
          )}

          {active.findings.length > 0 && (
            <>
              <h3>Your traits</h3>
              {active.findings.map((f) => (
                <div className="finding clickable" key={f.rsid} onClick={() => onJumpGene(f.gene)}>
                  <div className="finding-head">
                    <b>{f.trait}</b>
                    <span className="muted small">{f.gene} gene{expert && <> · {f.rsid} <code>{f.genotype}</code></>}</span>
                  </div>
                  <div>{f.interpretation}</div>
                </div>
              ))}
              <p className="muted small">Traits like these are shaped by many genes and by your environment, so treat them as fun hints.</p>
            </>
          )}
        </>
      )}

      {uploads.length > 0 && (
        <>
          <h3>Your files</h3>
          <ul className="upload-list">
            {uploads.map((u) => (
              <li key={u.id} className={u.id === activeId ? "active" : ""}>
                <label>
                  <input type="radio" checked={u.id === activeId} onChange={() => setActiveId(u.id)} />
                  <span>
                    <b>{u.name}</b>
                    <span className="muted small"> · {FORMAT_NAMES[u.format] ?? u.format}{expert && ` · ${u.build}`}</span>
                  </span>
                </label>
                <button
                  className="link-btn danger"
                  onClick={async () => {
                    if (!confirm(`Delete ${u.name}? This permanently removes its data.`)) return;
                    await api.deleteUpload(u.id);
                    onDeleted(u.id);
                  }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
          {activeId && <button className="link-btn" onClick={() => setActiveId(null)}>Hide my DNA from the map</button>}
          {active && (
            <details className="howto">
              <summary>Add another file</summary>
              <Uploader expert={expert} onUploaded={onUploaded} />
            </details>
          )}
        </>
      )}

      <p className="muted small privacy">
        🔒 Your file is processed on this server; only the list of differences is kept, and you can delete it any time.
        This tool is for learning and curiosity — it isn't medical advice.
      </p>
    </section>
  );
}

function Uploader({ expert, onUploaded }: { expert: boolean; onUploaded: (u: Upload) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [build, setBuild] = useState("");
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const send = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      onUploaded(await api.upload(file, build || undefined));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        className={`dropzone ${drag ? "drag" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files[0];
          if (f) send(f);
        }}
        onClick={() => fileRef.current?.click()}
      >
        <input ref={fileRef} type="file" hidden accept=".txt,.csv,.tsv,.vcf,.zip" onChange={(e) => e.target.files?.[0] && send(e.target.files[0])} />
        {busy ? (
          <p><span className="spinner" /> Reading your DNA… this can take up to a minute.</p>
        ) : (
          <>
            <p><b>Drop your file here</b> or click to choose it</p>
            <p className="muted small">Works with 23andMe, AncestryDNA, MyHeritage and FamilyTreeDNA files</p>
          </>
        )}
      </div>
      {expert && (
        <label className="build-select small">
          Genome build{" "}
          <select value={build} onChange={(e) => setBuild(e.target.value)}>
            <option value="">Auto-detect</option>
            <option value="GRCh37">GRCh37 / hg19</option>
            <option value="GRCh38">GRCh38 / hg38</option>
          </select>
        </label>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}

function ClinicalSection({ clinical, expert, showSensitive, setShowSensitive, onJump }: {
  clinical: NonNullable<Upload["clinical"]>;
  expert: boolean;
  showSensitive: boolean;
  setShowSensitive: (on: boolean) => void;
  onJump: (chrom: string, pos: number) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <h3>Health-related findings</h3>
      <div className="notice">
        <b>This is not a diagnosis.</b> Home DNA tests can get rare results wrong. If anything here worries you,
        talk to a doctor or genetic counselor, who can arrange a proper medical test.
      </div>
      {clinical.findings.length === 0 ? (
        <p>Good news: none of the differences we checked are known to be linked to a health condition.</p>
      ) : (
        <p className="muted small">
          We checked your differences against ClinVar, a public medical database. These are the ones it lists as
          affecting health or medicines{expert ? " (benign and uncertain-significance variants are not shown)" : ""}.
        </p>
      )}
      {clinical.findings.map((f, i) => (
        <ClinicalCard key={f.rsid + f.alt} f={f} expert={expert} open={open === i}
          onToggle={() => setOpen(open === i ? null : i)} onJump={onJump} />
      ))}
      <label className="sensitive-toggle">
        <input
          type="checkbox"
          checked={showSensitive}
          onChange={(e) => {
            if (e.target.checked && !confirm(
              "Show sensitive findings?\n\nThese include risk for conditions such as Alzheimer's disease that can't currently " +
              "be prevented or cured. Many people choose not to learn this, or to learn it with a genetic counselor.",
            )) return;
            setShowSensitive(e.target.checked);
          }}
        />
        <span>
          Also show sensitive findings, like Alzheimer's risk
          {!showSensitive && clinical.hiddenSensitive > 0 && (
            <span className="muted small"> · {clinical.hiddenSensitive} hidden</span>
          )}
        </span>
      </label>
    </>
  );
}

function ClinicalCard({ f, expert, open, onToggle, onJump }: {
  f: ClinicalFinding;
  expert: boolean;
  open: boolean;
  onToggle: () => void;
  onJump: (chrom: string, pos: number) => void;
}) {
  const meta = CLIN_PLAIN[f.class];
  const condition = f.plain?.conditions[0];
  return (
    <div className="finding clin" style={{ borderLeftColor: meta.color }}>
      <div className="finding-head" onClick={onToggle} role="button">
        <span className="clin-badge" style={{ background: meta.color }}>{meta.badge}</span>
        <span className="muted small">{f.gene} gene</span>
      </div>
      <div className="clin-condition" onClick={onToggle}>{findingTitle(f)}</div>
      <p className="small">{whatItMeans(f)}</p>
      <div className="clin-facts small">
        <span>{howCommon(f.af)}</span>
        <span>{evidenceLabel(f.stars)}</span>
      </div>
      {f.rare && (
        <div className="warn small">This is a rare result. Home DNA tests often get rare results wrong, so it should be confirmed with a medical test.</div>
      )}
      {open ? (
        <div className="clin-more small">
          {condition?.summary && <p>{firstSentence(condition.summary)} {condition.url && <a href={condition.url} target="_blank" rel="noreferrer">Learn more</a>}</p>}
          {f.plain && f.plain.conditions.length > 1 && (
            <div><b>Also linked to:</b> {f.plain.conditions.slice(1).map((c) => c.name).join(", ")}</div>
          )}
          {expert && (
            <>
              <div><b>ClinVar:</b> {f.significance}</div>
              <div><b>Review:</b> {"★".repeat(f.stars)}{"☆".repeat(4 - f.stars)} {f.review}</div>
              <div><b>Variant:</b> {f.rsid} · chr{shortChrom(f.chrom)}:{formatPos(f.pos)} {f.ref}&gt;{f.alt} · you <code>{f.genotype}</code></div>
              {f.consequence && <div><b>Effect:</b> {f.consequence}</div>}
              <div><b>Frequency:</b> {formatAf(f.af, f.afSource)}</div>
              {f.conditions.length > 0 && <div><b>ClinVar conditions:</b> {f.conditions.join("; ")}</div>}
            </>
          )}
          <div className="clin-actions">
            <button className="link-btn" onClick={() => onJump(f.chrom, f.pos)}>Show it on the map</button>
            <a href={`https://www.ncbi.nlm.nih.gov/clinvar/variation/${f.variationId}/`} target="_blank" rel="noreferrer">ClinVar record</a>
          </div>
        </div>
      ) : (
        <button className="link-btn small" onClick={onToggle}>More about this</button>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="stat">
      <div className="stat-value" style={{ color }}>{value.toLocaleString()}</div>
      <div className="muted small">{label}</div>
    </div>
  );
}

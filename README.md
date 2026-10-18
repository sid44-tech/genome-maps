# Genome Maps

A "Google Maps for the human genome". Start from the full karyotype, zoom into a
chromosome, keep zooming through genes and exons, and end at individual base pairs.
You can search for genes, diseases, traits, or coordinates. You can also upload a raw
DNA export from 23andMe, AncestryDNA, MyHeritage, FTDNA, or a VCF file, and see where
your genotype differs from the GRCh38 reference.

```
frontend/  React + TypeScript (Vite). Canvas map renderer, SVG karyotype.
backend/   Python FastAPI. In-memory gene index, memory-mapped .2bit reader, SQLite for uploads.
samples/   A synthetic 23andMe-format file (random genotypes, not a real person).
```

## Running it

```bash
make setup     # Python venv + npm install
make data      # downloads ~1 GB of public reference data, then builds genes.json / genome.json / clinvar.db
make backend   # http://localhost:8000  (API)
make frontend  # http://localhost:5173  (app; proxies /api to the backend)
make test
```

## Designed for non-experts

The app opens in **Simple** view, written for people with no biology background:

- **A first-visit guide** explains the map in three steps (zoom, search, add your DNA)
  and includes a short glossary. The **?** button reopens it.
- **Breadcrumbs and a zoom ladder** replace coordinates and zoom numbers. The
  breadcrumb reads *All chromosomes › Chromosome 7 › Neighborhood › CFTR gene ›
  DNA letters*, and the ladder on the right jumps straight to any of those stops.
- **Plain language everywhere.** Sizes are given as "302 thousand DNA letters", not
  "302 kb". Gene and condition descriptions come from MedlinePlus Genetics (written
  for patients). Health findings say what they mean ("You carry one copy, which makes
  you a carrier…"), how common they are ("About 1 in 115 people carry this"), and how
  strong the evidence is.
- **Less clutter.** Simple view hides the coordinate ruler, chromosome-band strip and
  reverse strand. When a stretch is crowded it names only well-known genes, the way a
  map names major streets first. A map key explains the colors.

**Detailed** view (the toggle sits next to the map key) brings back the scientific
layer: coordinates, cytobands, both strands, genome build, rsIDs, ClinVar review
status and variant tables. Every gene panel also keeps a "Technical details" section.

## How it works

**Map-style tiles.** The map keeps one viewport: a chromosome, a center coordinate,
and a bp-per-pixel value. Data is requested in power-of-two aligned tiles
(`/api/genes?chrom=chr7&start=117440512&end=117506048`). Panning reuses tiles that are
already cached, so only newly visible tiles get fetched. Every response is a pure
function of its URL, so it can be cached by the browser and a CDN
(`Cache-Control: max-age=86400`).

**Level of detail** (`frontend/src/view.ts`, `LOD`):

| Zoom | What you see | Data source |
|---|---|---|
| Whole genome | Karyotype with banded ideograms and search pins | `/api/genome` (32 KB, once) |
| > 4 kb/px | Cytobands plus a gene-density "terrain" | `/api/genes/density` |
| ≤ 4 kb/px | Individual genes with exons, UTRs, strand and labels | `/api/genes` |
| ≤ 8 bp/px | Reference sequence as colored bars | `/api/sequence` (memory-mapped hg38.2bit) |
| ≤ 1/9 bp/px | Base letters on both strands, plus your genotype | same |

**Interaction:** drag to pan (with inertia) and scroll or pinch to zoom around the
cursor. Double-click zooms in; shift-double-click zooms out. `+` / `-` / arrow keys
work too, and `/` focuses search. Scrolling out past a whole chromosome returns to the
karyotype. The URL hash (`#chr7:117480025-117668665`) always reflects the view, so
links can be shared.

**Search** covers gene symbols, synonyms, full names, ClinVar conditions, curated traits,
and coordinates (`chr7`, `7:117,559,590`, `chrX:1000-2000`). Category chips such as
Physical appearance, Drug response, Cancer, and Heart pin every matching gene on the map.

**Your DNA** (`backend/app/dna_upload.py`):
1. Detects the file format and genome build. Array exports are GRCh37.
2. Lifts positions over to GRCh38 (UCSC chain, strand-aware).
3. Compares each genotype to the reference base and stores only the differences
   (heterozygous or homozygous).
4. Reads the 13 curated trait SNPs (eye color, lactose, earwax, caffeine, and others)
   directly from the raw genotype.
5. Annotates each difference against ClinVar (`backend/data/clinvar.db`, built by
   `scripts/build_clinvar.py` from ClinVar's GRCh38 VCF). A match requires the same
   position *and* the same alternate allele. Each match carries its classification,
   review stars, conditions, molecular effect, and population allele frequency
   (ExAC, then 1000 Genomes, then ESP).

**Clinical findings.** The Your DNA panel lists pathogenic, risk-factor, and
drug-response matches, with pathogenic first. Benign and uncertain-significance
(VUS) variants are dropped from the database entirely, as consumer reports usually
do. Every finding is shown as a diamond on the map at every zoom level; clicking a
diamond flies to that base. Pathogenic calls below 0.1% allele frequency carry a
warning, because consumer arrays often mis-call rare variants.

**Sensitive genes are opt-in.** Findings in genes like APOE (Alzheimer's risk), HTT
and PSEN1/2 are withheld by the API unless the request has `?sensitive=true`. The UI
sends that only after the viewer ticks a confirmation. Until then the count of hidden
findings is shown, but not the findings themselves. The list is `SENSITIVE_GENES` in
`dna_upload.py`.

Existing uploads are re-annotated automatically when `clinvar.db` is rebuilt.

The raw file is never written to disk. A data set can be deleted from the panel.

## Data sources

| Data | Source |
|---|---|
| Cytobands, RefSeq gene models, hg38 sequence, hg19→hg38 chain | UCSC Genome Browser |
| Gene names and types | NCBI Gene `gene_info` |
| Gene → condition | ClinVar `gene_condition_source_id` |
| Variant classifications and allele frequencies | ClinVar GRCh38 VCF (`clinvar.vcf.gz`) |
| Plain-language gene and condition summaries | MedlinePlus Genetics (`ghr-summaries.xml`) |
| Trait genes and SNPs | Hand-curated: `backend/data/curated_traits.json` |

## Known limitations and next steps

- **Multi-user / privacy:** uploads are not scoped to a user yet. Anyone who can reach
  the server can list them. Accounts (or client-side-only processing) are needed
  before this is deployed anywhere public. Genetic data deserves encryption at rest.
- **Allele frequencies** only exist for variants that are in ClinVar. Frequencies for
  every difference would need gnomAD, which is tens of GB and would have to be
  pre-filtered to array SNP positions.
- **Clinical annotation** covers single-nucleotide variants only. Indels (e.g. CFTR
  F508del) are reported by arrays as `I`/`D` codes, which are skipped. ClinVar
  conditions are listed in ClinVar's own order, which is not ranked by relevance.
- **Gene models:** one canonical (longest) RefSeq transcript per gene. Showing all
  isoforms, or MANE Select, would be more precise.
- **Upload speed:** a full 23andMe file (~640k SNPs) takes about 10 s and is processed
  synchronously. A background job with progress reporting would be better at scale.
- **Mobile:** the layout has a narrow-window mode, but it hasn't been tested on
  phones, and touch pinch-zoom is not implemented (trackpad pinch works).

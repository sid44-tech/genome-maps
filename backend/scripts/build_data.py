"""Build the compact data files the API serves from the raw UCSC / NCBI downloads.

Inputs (backend/data/raw, fetched by scripts/fetch_data.sh):
  cytoBand.txt.gz             UCSC hg38 cytogenetic bands (karyotype)
  refGene.txt.gz              UCSC hg38 RefSeq gene models
  Homo_sapiens.gene_info.gz   NCBI gene descriptions + gene types
  gene_condition_source_id    ClinVar gene -> condition table

Outputs (backend/data):
  genome.json   chromosome lengths + cytobands
  genes.json    one canonical model per gene, with exons, description, diseases, categories
"""

from __future__ import annotations

import csv
import gzip
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
RAW = DATA / "raw"

CHROMS = [f"chr{i}" for i in range(1, 23)] + ["chrX", "chrY", "chrM"]

CANCER_RE = re.compile(
    r"cancer|carcinoma|tumou?r|leukemia|lymphoma|neoplas|sarcoma|melanoma|glioma|blastoma|myeloma",
    re.I,
)
CARDIO_RE = re.compile(r"cardi|heart|arrhythm|long qt|brugada|aort", re.I)
NEURO_RE = re.compile(
    r"neur|epilep|seizure|intellectual disability|alzheimer|parkinson|ataxia|dystroph|myopath|"
    r"autism|dementia|encephalopath|charcot",
    re.I,
)
METABOLIC_RE = re.compile(r"deficiency|metaboli|storage disease|acidemia|aciduria|glycogen|diabet", re.I)
VISION_HEARING_RE = re.compile(r"retin|blind|deaf|hearing|cataract|glaucoma|eye", re.I)


def build_genome() -> dict:
    lengths: dict[str, int] = defaultdict(int)
    bands: dict[str, list] = defaultdict(list)
    with gzip.open(RAW / "cytoBand.txt.gz", "rt") as fh:
        for chrom, start, end, name, stain in csv.reader(fh, delimiter="\t"):
            if chrom not in CHROMS:
                continue
            start, end = int(start), int(end)
            bands[chrom].append([start, end, name, stain])
            lengths[chrom] = max(lengths[chrom], end)
    # chrM has no bands in cytoBand; length from the rCRS reference.
    lengths.setdefault("chrM", 16569)
    return {
        "assembly": "GRCh38/hg38",
        "chromosomes": [
            {"name": c, "length": lengths[c], "bands": sorted(bands.get(c, []))}
            for c in CHROMS
            if c in lengths
        ],
    }


def load_gene_info() -> dict[str, dict]:
    info: dict[str, dict] = {}
    with gzip.open(RAW / "Homo_sapiens.gene_info.gz", "rt") as fh:
        reader = csv.reader(fh, delimiter="\t")
        next(reader)
        for row in reader:
            gene_id, symbol, synonyms, xrefs, description, gtype = row[1], row[2], row[4], row[5], row[8], row[9]
            designations = "" if row[13] == "-" else row[13].replace("|", "; ")
            mim = next((x[4:] for x in xrefs.split("|") if x.startswith("MIM:")), None)
            info[symbol] = {
                "geneId": int(gene_id),
                "description": description,
                "type": gtype,
                "synonyms": [] if synonyms == "-" else synonyms.split("|"),
                "mim": mim,
                "designations": designations[:400],
            }
    return info


def load_conditions() -> dict[str, list[str]]:
    conditions: dict[str, set[str]] = defaultdict(set)
    with open(RAW / "gene_condition_source_id") as fh:
        reader = csv.reader(fh, delimiter="\t")
        next(reader)
        for row in reader:
            symbol, disease = row[1], row[4]
            if symbol and disease:
                conditions[symbol].add(disease)
    return {k: sorted(v) for k, v in conditions.items()}


def load_curated() -> dict[str, list[dict]]:
    """Map gene symbol -> list of curated trait entries."""
    curated = json.loads((DATA / "curated_traits.json").read_text())
    by_gene: dict[str, list[dict]] = defaultdict(list)
    for cat in curated["categories"]:
        for entry in cat["genes"]:
            by_gene[entry["symbol"]].append({"category": cat["id"], "trait": entry["trait"]})
    return by_gene


def disease_categories(diseases: list[str]) -> set[str]:
    cats = {"disease"} if diseases else set()
    joined = " | ".join(diseases)
    for cat, rx in (
        ("cancer", CANCER_RE),
        ("cardiovascular", CARDIO_RE),
        ("neurological", NEURO_RE),
        ("metabolic", METABOLIC_RE),
        ("vision-hearing", VISION_HEARING_RE),
    ):
        if rx.search(joined):
            cats.add(cat)
    return cats


def build_genes() -> list[dict]:
    info = load_gene_info()
    conditions = load_conditions()
    curated = load_curated()

    # Pick the longest transcript per (symbol, chrom) as the canonical gene model.
    best: dict[tuple[str, str], list] = {}
    with gzip.open(RAW / "refGene.txt.gz", "rt") as fh:
        for row in csv.reader(fh, delimiter="\t"):
            chrom, symbol = row[2], row[12]
            if chrom not in CHROMS:
                continue
            tx_start, tx_end = int(row[4]), int(row[5])
            key = (symbol, chrom)
            cur = best.get(key)
            if cur is None or (tx_end - tx_start) > (int(cur[5]) - int(cur[4])):
                best[key] = row

    genes = []
    for (symbol, chrom), row in best.items():
        meta = info.get(symbol, {})
        diseases = conditions.get(symbol, [])
        traits = curated.get(symbol, [])
        cats = disease_categories(diseases) | {t["category"] for t in traits}
        exon_starts = [int(x) for x in row[9].rstrip(",").split(",")]
        exon_ends = [int(x) for x in row[10].rstrip(",").split(",")]
        genes.append(
            {
                "symbol": symbol,
                "chrom": chrom,
                "start": int(row[4]),
                "end": int(row[5]),
                "strand": row[3],
                "transcript": row[1],
                "cdsStart": int(row[6]),
                "cdsEnd": int(row[7]),
                "exons": [[s, e] for s, e in zip(exon_starts, exon_ends)],
                "geneId": meta.get("geneId"),
                "description": meta.get("description", ""),
                "type": meta.get("type", "unknown"),
                "synonyms": meta.get("synonyms", []),
                "mim": meta.get("mim"),
                "designations": meta.get("designations", ""),
                "diseases": diseases,
                "traits": traits,
                "categories": sorted(cats),
            }
        )
    genes.sort(key=lambda g: (CHROMS.index(g["chrom"]), g["start"]))
    return genes


def main() -> int:
    genome = build_genome()
    (DATA / "genome.json").write_text(json.dumps(genome, separators=(",", ":")))
    genes = build_genes()
    (DATA / "genes.json").write_text(json.dumps(genes, separators=(",", ":")))
    n_disease = sum(1 for g in genes if g["diseases"])
    n_trait = sum(1 for g in genes if g["traits"])
    print(f"{len(genome['chromosomes'])} chromosomes, {len(genes)} genes "
          f"({n_disease} disease-linked, {n_trait} curated traits)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

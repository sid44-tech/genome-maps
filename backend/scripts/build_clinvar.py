"""Build backend/data/clinvar.db from ClinVar's GRCh38 VCF.

Keeps single-nucleotide variants only (what consumer arrays measure) whose
classification is clinically notable -- benign and uncertain-significance (VUS)
entries are dropped, as consumer reports conventionally do. Keyed by
(chrom, pos, alt) on GRCh38, with the aggregate classification, review status,
conditions, gene, consequence and the best available population allele frequency.

    python scripts/build_clinvar.py
"""

from __future__ import annotations

import gzip
import sqlite3
import sys
import time
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
SRC = DATA / "raw" / "clinvar.vcf.gz"
OUT = DATA / "clinvar.db"

STARS = {
    "practice_guideline": 4,
    "reviewed_by_expert_panel": 3,
    "criteria_provided,_multiple_submitters,_no_conflicts": 2,
    "criteria_provided,_single_submitter": 1,
    "criteria_provided,_conflicting_classifications": 1,
}


DROP = {"benign", "vus"}
PLACEHOLDER_CONDITIONS = {"not_provided", "not_specified", "See_cases", "Inborn_genetic_diseases"}


def classify(sig: str) -> str:
    """Collapse ClinVar's CLNSIG vocabulary into a few display classes.

    CLNSIG can combine a germline call with extra labels ("Conflicting_classifications_
    of_pathogenicity|other|risk_factor", "Pathogenic|drug_response"), so each
    component is classified and the most significant one wins.
    """
    order = ["pathogenic", "risk", "drug", "conflicting", "vus", "other", "benign"]
    found = {_classify_one(part) for part in sig.split("|")}
    return min(found, key=order.index)


def _classify_one(s: str) -> str:
    s = s.lower()
    if "conflicting" in s:
        return "conflicting"
    if "pathogenic" in s and "benign" not in s:
        return "pathogenic"
    if "risk_factor" in s or "association" in s or "affects" in s or "protective" in s:
        return "risk"
    if "drug_response" in s:
        return "drug"
    if "uncertain" in s:
        return "vus"
    if "benign" in s:
        return "benign"
    return "other"


def main() -> int:
    t0 = time.time()
    tmp = OUT.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    db = sqlite3.connect(tmp)
    db.executescript(
        """
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        CREATE TABLE clinvar (
            chrom TEXT, pos INTEGER, ref TEXT, alt TEXT,
            variation_id INTEGER, rsid TEXT, significance TEXT, class TEXT,
            review TEXT, stars INTEGER, conditions TEXT, gene TEXT, consequence TEXT,
            af REAL, af_source TEXT,
            PRIMARY KEY (chrom, pos, alt)
        ) WITHOUT ROWID;
        """
    )
    rows = []
    n = 0
    with gzip.open(SRC, "rt") as fh:
        for line in fh:
            if line[0] == "#":
                continue
            chrom, pos, vid, ref, alt, _, _, info = line.rstrip("\n").split("\t", 7)
            if len(ref) != 1 or len(alt) != 1 or alt not in "ACGT":
                continue
            f = dict(kv.split("=", 1) for kv in info.split(";") if "=" in kv)
            sig = f.get("CLNSIG")
            if not sig or classify(sig) in DROP:
                continue
            af, src = None, None
            for key, label in (("AF_EXAC", "ExAC"), ("AF_TGP", "1000 Genomes"), ("AF_ESP", "ESP")):
                if key in f:
                    af, src = float(f[key]), label
                    break
            conditions = "|".join(
                c.replace("_", " ") for c in f.get("CLNDN", "").split("|")
                if c and c not in PLACEHOLDER_CONDITIONS
            )
            review = f.get("CLNREVSTAT", "")
            consequence = f.get("MC", "").split(",")[0].partition("|")[2].replace("_", " ")
            rows.append((
                "chrM" if chrom == "MT" else f"chr{chrom}", int(pos), ref, alt, int(vid),
                f"rs{f['RS']}" if "RS" in f else None,
                sig.replace("_", " "), classify(sig),
                review.replace("_", " ").replace(" ,", ","), STARS.get(review, 0),
                conditions, f.get("GENEINFO", "").split(":")[0] or None, consequence or None,
                af, src,
            ))
            if len(rows) >= 100_000:
                db.executemany("INSERT OR REPLACE INTO clinvar VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
                n += len(rows)
                rows.clear()
    db.executemany("INSERT OR REPLACE INTO clinvar VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    n += len(rows)
    db.commit()
    counts = dict(db.execute("SELECT class, COUNT(*) FROM clinvar GROUP BY class").fetchall())
    db.close()
    tmp.replace(OUT)
    print(f"{n:,} ClinVar SNVs in {time.time() - t0:.0f}s -> {OUT.name}: {counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

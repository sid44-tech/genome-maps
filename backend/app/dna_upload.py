"""Parse consumer raw-DNA exports and compare genotypes to the GRCh38 reference.

Supported inputs:
  * 23andMe            rsid  chromosome  position  genotype       (tab, GRCh37)
  * AncestryDNA        rsid  chromosome  position  allele1 allele2 (tab, GRCh37)
  * MyHeritage / FTDNA "RSID","CHROMOSOME","POSITION","RESULT"     (csv, GRCh37)
  * VCF                single-sample VCF, GRCh37 or GRCh38 (detected from header)

Array exports are reported on GRCh37 coordinates, so positions are lifted over
to GRCh38 before looking up the reference base. Only the derived variant table
is stored; the raw upload is never written to disk.

Differences are then annotated against ClinVar (data/clinvar.db, built by
scripts/build_clinvar.py): classification, review status, conditions and
population allele frequency, matched on the exact alternate allele.
"""

from __future__ import annotations

import io
import json
import re
import sqlite3
import time
import uuid
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator

from .plain import Plain, drug_names
from .twobit import TwoBitFile

COMPLEMENT = str.maketrans("ACGT", "TGCA")
ANCESTRY_CHROMS = {"23": "X", "24": "Y", "25": "X", "26": "MT"}
GRCH37_CHR1 = 249250621
GRCH38_CHR1 = 248956422

# Genes whose findings carry serious, largely unactionable implications (e.g. APOE
# and Alzheimer's risk, Huntington's). Hidden unless the viewer explicitly opts in.
SENSITIVE_GENES = {
    "APOE", "HTT", "PSEN1", "PSEN2", "APP", "PRNP", "MAPT", "GRN", "C9orf72",
    "TARDBP", "SOD1", "FUS", "TREM2",
}
CLIN_RANK = {"pathogenic": 0, "risk": 1, "drug": 2, "conflicting": 3, "other": 4}
REPORTED = {"pathogenic", "risk", "drug"}
RARE_AF = 0.001
ANNOTATION_VERSION = 2  # bump when annotation logic changes, to re-annotate stored uploads
CLIN_COLUMNS = {
    "clin_class": "TEXT", "clin_sig": "TEXT", "clin_stars": "INTEGER", "clin_review": "TEXT",
    "clin_conditions": "TEXT", "clin_gene": "TEXT", "clin_consequence": "TEXT",
    "clin_variation_id": "INTEGER", "clin_alt": "TEXT", "af": "REAL", "af_source": "TEXT",
    "sensitive": "INTEGER",
}


@dataclass
class Call:
    rsid: str
    chrom: str  # 'chr1'..'chrX','chrY','chrM'
    pos: int  # 1-based, in the file's build
    alleles: str  # '', 'A', 'AG' ...


def normalize_chrom(c: str) -> str | None:
    c = c.strip().removeprefix("chr").upper()
    c = ANCESTRY_CHROMS.get(c, c)
    if c in ("MT", "M"):
        return "chrM"
    if c in ("X", "Y", "XY") or (c.isdigit() and 1 <= int(c) <= 22):
        return "chrX" if c == "XY" else f"chr{c}"
    return None


def detect(header_lines: list[str]) -> tuple[str, str]:
    """Return (format, build) from the first lines of a file."""
    head = "\n".join(header_lines)
    low = head.lower()
    if head.startswith("##fileformat=VCF"):
        fmt = "vcf"
    elif "allele1" in low and "allele2" in low:
        fmt = "ancestry"
    elif re.search(r'^"?rsid"?\s*,', low, re.M):
        fmt = "csv"
    else:
        fmt = "23andme"

    build = "GRCh37"
    if re.search(r"grch38|hg38|build 38", low) or f"length={GRCH38_CHR1}" in head:
        build = "GRCh38"
    if re.search(r"grch37|hg19|build 37", low) or f"length={GRCH37_CHR1}" in head:
        build = "GRCh37"
    return fmt, build


def parse(lines: Iterable[str], fmt: str) -> Iterator[Call]:
    for line in lines:
        line = line.rstrip("\r\n")
        if not line or line.startswith("#"):
            continue
        if fmt == "vcf":
            yield from _parse_vcf_line(line)
            continue
        parts = [p.strip().strip('"') for p in (line.split(",") if fmt == "csv" else line.split("\t"))]
        if len(parts) < 4 or parts[0].lower() == "rsid":
            continue
        chrom = normalize_chrom(parts[1])
        if chrom is None or not parts[2].isdigit():
            continue
        if fmt == "ancestry" and len(parts) >= 5:
            geno = parts[3] + parts[4]
        else:
            geno = parts[3]
        geno = geno.upper()
        if not geno or any(ch not in "ACGT" for ch in geno):
            geno = ""  # no-call ('--', '00') or indel ('DI', 'II')
        yield Call(parts[0], chrom, int(parts[2]), geno)


def _parse_vcf_line(line: str) -> Iterator[Call]:
    f = line.split("\t")
    if len(f) < 10:
        return
    chrom = normalize_chrom(f[0])
    ref, alts = f[3].upper(), f[4].upper().split(",")
    if chrom is None or len(ref) != 1:
        return
    alleles = [ref] + alts
    fmt_keys = f[8].split(":")
    if "GT" not in fmt_keys:
        return
    gt = f[9].split(":")[fmt_keys.index("GT")]
    out = ""
    for a in re.split(r"[/|]", gt):
        if not a.isdigit() or int(a) >= len(alleles) or len(alleles[int(a)]) != 1:
            out = ""
            break
        out += alleles[int(a)]
    yield Call(f[2] if f[2] != "." else f"{chrom}:{f[1]}", chrom, int(f[1]), out)


class UploadStore:
    def __init__(self, db_path: Path, twobit: TwoBitFile, chain_path: Path, curated_snps: dict[str, dict],
                 clinvar_path: Path | None = None, plain: Plain | None = None):
        self.db_path = db_path
        self.plain = plain
        self.clinvar_path = clinvar_path if clinvar_path and clinvar_path.exists() else None
        self.twobit = twobit
        self.chain_path = chain_path
        self.curated_snps = curated_snps
        self._lifter = None
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            c.executescript(
                """
                CREATE TABLE IF NOT EXISTS uploads (
                    id TEXT PRIMARY KEY, name TEXT, created REAL, format TEXT, build TEXT, stats TEXT);
                CREATE TABLE IF NOT EXISTS variants (
                    upload_id TEXT, chrom TEXT, pos INTEGER, rsid TEXT, ref TEXT, genotype TEXT,
                    zygosity INTEGER);
                CREATE INDEX IF NOT EXISTS variants_loc ON variants (upload_id, chrom, pos);
                """
            )
            have = {r["name"] for r in c.execute("PRAGMA table_info(variants)")}
            for col, typ in CLIN_COLUMNS.items():
                if col not in have:
                    c.execute(f"ALTER TABLE variants ADD COLUMN {col} {typ}")
        # Annotate uploads made before ClinVar data was available.
        # Re-annotate uploads made before ClinVar data existed or with an older build of it.
        if self.clinvar_path:
            plain_path = Path(__file__).resolve().parent.parent / "data" / "plain.json"
            self.clinvar_version = f"{ANNOTATION_VERSION}:{int(self.clinvar_path.stat().st_mtime)}:" + (
                str(int(plain_path.stat().st_mtime)) if plain_path.exists() else "")
            for u in self._raw_uploads():
                if u["stats"].get("clinical", {}).get("clinvarVersion") != self.clinvar_version:
                    self.annotate(u["id"])

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    @property
    def lifter(self):
        if self._lifter is None:
            from pyliftover import LiftOver

            self._lifter = LiftOver(str(self.chain_path))
        return self._lifter

    # ---- ingest -----------------------------------------------------------

    def ingest(self, name: str, raw: bytes, build_override: str | None = None) -> dict:
        text = io.StringIO(raw.decode("utf-8", errors="replace"))
        head = [text.readline() for _ in range(40)]
        fmt, build = detect(head)
        if build_override in ("GRCh37", "GRCh38"):
            build = build_override
        text.seek(0)

        upload_id = uuid.uuid4().hex[:12]
        stats = Counter()
        per_chrom: Counter = Counter()
        findings = []
        rows = []
        for call in parse(text, fmt):
            stats["total"] += 1
            if not call.alleles:
                stats["no_call"] += 1
                continue
            stats["called"] += 1

            snp = self.curated_snps.get(call.rsid)
            if snp:
                n = call.alleles.count(snp["effectAllele"])
                findings.append({
                    **{k: snp[k] for k in ("rsid", "gene", "trait", "effectAllele")},
                    "genotype": call.alleles,
                    "copies": n,
                    "interpretation": snp["interpretation"].get(str(min(n, 2)), ""),
                })

            chrom, pos0, alleles = call.chrom, call.pos - 1, call.alleles
            if build == "GRCh37":
                lifted = self.lifter.convert_coordinate(chrom, pos0)
                if not lifted:
                    stats["unmapped"] += 1
                    continue
                chrom, pos0, strand = lifted[0][0], lifted[0][1], lifted[0][2]
                if strand == "-":
                    alleles = alleles.translate(COMPLEMENT)
            ref = self.twobit.base_at(chrom, pos0) if chrom in self.twobit._offsets else "N"
            if ref == "N":
                stats["unmapped"] += 1
                continue
            alt_count = sum(1 for a in alleles if a != ref)
            if alt_count == 0:
                stats["hom_ref"] += 1
                continue
            zyg = 1 if alt_count < len(alleles) else 2
            stats["het" if zyg == 1 else "hom_alt"] += 1
            per_chrom[chrom] += 1
            rows.append((upload_id, chrom, pos0 + 1, call.rsid, ref, alleles, zyg))

        if stats["called"] == 0:
            raise ValueError("No genotype calls found. Is this a 23andMe, AncestryDNA, MyHeritage or VCF file?")

        summary = {
            "counts": dict(stats),
            "variantsPerChrom": dict(per_chrom),
            "findings": sorted(findings, key=lambda f: f["gene"]),
        }
        with self._conn() as c:
            c.execute(
                "INSERT INTO uploads VALUES (?,?,?,?,?,?)",
                (upload_id, name, time.time(), fmt, build, json.dumps(summary)),
            )
            c.executemany(
                "INSERT INTO variants (upload_id, chrom, pos, rsid, ref, genotype, zygosity) VALUES (?,?,?,?,?,?,?)",
                rows,
            )
        if self.clinvar_path:
            self.annotate(upload_id)
        return self.get(upload_id)

    # ---- ClinVar annotation -----------------------------------------------

    def annotate(self, upload_id: str) -> dict:
        """Match this upload's differences to ClinVar on (chrom, pos, alt allele)."""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("ATTACH DATABASE ? AS cv", (str(self.clinvar_path),))
            candidates = conn.execute(
                """
                SELECT v.rowid AS vrow, v.rsid AS user_rsid, v.chrom, v.pos, v.ref AS user_ref, v.genotype,
                       c.alt, c.rsid, c.significance, c.class, c.stars, c.review, c.conditions, c.gene,
                       c.consequence, c.variation_id, c.af, c.af_source
                FROM variants v JOIN cv.clinvar c ON c.chrom = v.chrom AND c.pos = v.pos
                WHERE v.upload_id = ? AND instr(v.genotype, c.alt) > 0
                """,
                (upload_id,),
            ).fetchall()
            conn.execute("DETACH DATABASE cv")

            best: dict[int, sqlite3.Row] = {}
            for r in candidates:
                cur = best.get(r["vrow"])
                if cur is None or (CLIN_RANK[r["class"]], -r["stars"]) < (CLIN_RANK[cur["class"]], -cur["stars"]):
                    best[r["vrow"]] = r

            findings, counts = [], Counter()
            updates = []
            for r in best.values():
                sensitive = int(r["gene"] in SENSITIVE_GENES)
                counts[r["class"]] += 1
                updates.append((r["class"], r["significance"], r["stars"], r["review"], r["conditions"], r["gene"],
                                r["consequence"], r["variation_id"], r["alt"], r["af"], r["af_source"], sensitive,
                                r["vrow"]))
                # SNPs with a curated trait reading (eye color, lactose...) are reported as traits, not health.
                if r["class"] in REPORTED and r["user_rsid"] not in self.curated_snps:
                    findings.append(_finding(r, sensitive, self.plain))
            # Reset first so a re-annotation drops matches the new ClinVar build no longer has.
            conn.execute("UPDATE variants SET clin_class=NULL WHERE upload_id=?", (upload_id,))
            conn.executemany(
                "UPDATE variants SET clin_class=?, clin_sig=?, clin_stars=?, clin_review=?, clin_conditions=?, "
                "clin_gene=?, clin_consequence=?, clin_variation_id=?, clin_alt=?, af=?, af_source=?, sensitive=? "
                "WHERE rowid=?",
                updates,
            )
            findings.sort(key=lambda f: (CLIN_RANK[f["class"]], -f["stars"], f["af"] if f["af"] is not None else -1))
            clinical = {"counts": dict(counts), "findings": findings, "clinvarMatches": len(best),
                        "clinvarVersion": self.clinvar_version}
            row = conn.execute("SELECT stats FROM uploads WHERE id=?", (upload_id,)).fetchone()
            stats = json.loads(row["stats"])
            stats["clinical"] = clinical
            conn.execute("UPDATE uploads SET stats=? WHERE id=?", (json.dumps(stats), upload_id))
            conn.commit()
        finally:
            conn.close()
        return clinical

    # ---- queries ----------------------------------------------------------

    def _raw_uploads(self) -> list[dict]:
        with self._conn() as c:
            rows = c.execute("SELECT id, stats FROM uploads").fetchall()
        return [{"id": r["id"], "stats": json.loads(r["stats"])} for r in rows]

    def list(self, include_sensitive: bool = False) -> list[dict]:
        with self._conn() as c:
            rows = c.execute("SELECT id FROM uploads ORDER BY created DESC").fetchall()
        return [self.get(r["id"], include_sensitive) for r in rows]

    def get(self, upload_id: str, include_sensitive: bool = False) -> dict | None:
        with self._conn() as c:
            r = c.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
        if r is None:
            return None
        stats = json.loads(r["stats"])
        # Trait wording comes from the curated file at read time, so edits apply to old uploads too.
        traits = []
        for f in stats.get("findings", []):
            snp = self.curated_snps.get(f["rsid"])
            if snp:
                traits.append({**f, "trait": snp["trait"],
                               "interpretation": snp["interpretation"].get(str(min(f["copies"], 2)), "")})
        stats["findings"] = traits
        clinical = stats.get("clinical")
        if clinical is not None:
            visible = [f for f in clinical["findings"] if include_sensitive or not f["sensitive"]]
            stats["clinical"] = {**clinical, "findings": visible,
                                 "hiddenSensitive": len(clinical["findings"]) - len(visible)}
        return {"id": r["id"], "name": r["name"], "created": r["created"], "format": r["format"],
                "build": r["build"], **stats}

    def delete(self, upload_id: str) -> bool:
        with self._conn() as c:
            c.execute("DELETE FROM variants WHERE upload_id=?", (upload_id,))
            n = c.execute("DELETE FROM uploads WHERE id=?", (upload_id,)).rowcount
        return n > 0

    def variants(self, upload_id: str, chrom: str, start: int, end: int, limit: int = 5000,
                 include_sensitive: bool = False) -> list[dict]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT pos, rsid, ref, genotype, zygosity, clin_class, clin_sig, clin_stars, clin_review, "
                "clin_conditions, clin_gene, clin_consequence, clin_variation_id, clin_alt, af, af_source, sensitive "
                "FROM variants WHERE upload_id=? AND chrom=? AND pos>? AND pos<=? ORDER BY pos LIMIT ?",
                (upload_id, chrom, start, end, limit),
            ).fetchall()
        out = []
        for r in rows:
            v = {k: r[k] for k in ("pos", "rsid", "ref", "genotype", "zygosity")}
            if r["clin_class"] and (include_sensitive or not r["sensitive"]):
                v["clinvar"] = {
                    "class": r["clin_class"], "significance": r["clin_sig"], "stars": r["clin_stars"],
                    "review": r["clin_review"], "conditions": _conditions(r["clin_conditions"]),
                    "gene": r["clin_gene"], "consequence": r["clin_consequence"],
                    "variationId": r["clin_variation_id"], "alt": r["clin_alt"],
                }
                v["af"], v["afSource"] = r["af"], r["af_source"]
            elif r["clin_class"]:
                v["hiddenSensitive"] = True
            out.append(v)
        return out

    def density(self, upload_id: str, chrom: str, start: int, end: int, bins: int) -> list[int]:
        width = max(1, (end - start) / bins)
        with self._conn() as c:
            rows = c.execute(
                "SELECT CAST((pos - 1 - ?) / ? AS INTEGER) AS b, COUNT(*) AS n FROM variants "
                "WHERE upload_id=? AND chrom=? AND pos>? AND pos<=? GROUP BY b",
                (start, width, upload_id, chrom, start, end),
            ).fetchall()
        out = [0] * bins
        for r in rows:
            if 0 <= r["b"] < bins:
                out[r["b"]] = r["n"]
        return out


def _conditions(s: str | None, limit: int = 12) -> list[str]:
    return [c for c in (s or "").split("|") if c][:limit]


def _finding(r: sqlite3.Row, sensitive: int, plain: Plain | None) -> dict:
    copies = r["genotype"].count(r["alt"])
    all_conditions = _conditions(r["conditions"], limit=100)
    return {
        "plain": {
            "conditions": plain.match_conditions(r["gene"], all_conditions) if plain else [],
            "drugs": drug_names(all_conditions) if r["class"] == "drug" else [],
        },
        "rsid": r["rsid"] or r["user_rsid"], "chrom": r["chrom"], "pos": r["pos"], "gene": r["gene"],
        "ref": r["user_ref"], "alt": r["alt"], "genotype": r["genotype"], "copies": copies,
        "class": r["class"], "significance": r["significance"], "stars": r["stars"], "review": r["review"],
        "conditions": _conditions(r["conditions"]), "consequence": r["consequence"],
        "variationId": r["variation_id"], "af": r["af"], "afSource": r["af_source"],
        # Rare "pathogenic" calls from genotyping arrays are frequently false positives.
        "rare": r["class"] == "pathogenic" and (r["af"] is None or r["af"] < RARE_AF),
        "sensitive": bool(sensitive),
    }

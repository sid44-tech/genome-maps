"""In-memory genome annotation index: chromosomes, cytobands, genes, search."""

from __future__ import annotations

import bisect
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"


@dataclass
class ChromIndex:
    genes: list[dict] = field(default_factory=list)
    starts: list[int] = field(default_factory=list)
    max_len: int = 0


class Genome:
    def __init__(self, data_dir: Path = DATA):
        self.info = json.loads((data_dir / "genome.json").read_text())
        self.lengths = {c["name"]: c["length"] for c in self.info["chromosomes"]}
        curated = json.loads((data_dir / "curated_traits.json").read_text())
        self.curated_snps = {s["rsid"]: s for s in curated["snps"]}
        self.categories = [{"id": c["id"], "label": c["label"]} for c in curated["categories"]] + [
            {"id": "disease", "label": "Any disease"},
            {"id": "cancer", "label": "Cancer"},
            {"id": "cardiovascular", "label": "Heart & vessels"},
            {"id": "neurological", "label": "Brain & nerves"},
            {"id": "metabolic", "label": "Metabolic disorders"},
            {"id": "vision-hearing", "label": "Vision & hearing"},
        ]

        genes = json.loads((data_dir / "genes.json").read_text())
        self.by_chrom: dict[str, ChromIndex] = {c: ChromIndex() for c in self.lengths}
        self.by_symbol: dict[str, list[dict]] = {}
        for i, g in enumerate(genes):
            g["id"] = i
            idx = self.by_chrom.get(g["chrom"])
            if idx is None:
                continue
            idx.genes.append(g)
            idx.starts.append(g["start"])
            idx.max_len = max(idx.max_len, g["end"] - g["start"])
            self.by_symbol.setdefault(g["symbol"].upper(), []).append(g)
        self.genes = genes
        # Lowercased search blob per gene, built once.
        self._search_text = [
            " ".join([g["symbol"], g["description"], g.get("designations", ""), *g["synonyms"], *g["diseases"],
                      *(t["trait"] for t in g["traits"])]).lower()
            for g in genes
        ]

    def add_blurbs(self, plain) -> None:
        """One friendly line per gene for search results: a trait, or what it's linked to."""
        for g in self.genes:
            linked = [c["name"] for c in plain.gene_conditions(g["symbol"])] or g["diseases"]
            if g["traits"]:
                g["blurb"] = g["traits"][0]["trait"]
            elif linked:
                g["blurb"] = "Linked to " + ", ".join(linked[:2]) + (" and more" if len(linked) > 2 else "")
            else:
                g["blurb"] = None
        for c in self.info["chromosomes"]:
            c["geneCount"] = sum(1 for g in self.by_chrom[c["name"]].genes if g["type"] == "protein-coding")

    # ---- viewport queries -------------------------------------------------

    def genes_in(self, chrom: str, start: int, end: int) -> list[dict]:
        idx = self.by_chrom[chrom]
        lo = bisect.bisect_left(idx.starts, start - idx.max_len)
        hi = bisect.bisect_left(idx.starts, end)
        return [g for g in idx.genes[lo:hi] if g["end"] > start]

    def density(self, chrom: str, start: int, end: int, bins: int) -> list[int]:
        counts = [0] * bins
        span = max(1, end - start)
        for g in self.genes_in(chrom, start, end):
            mid = (g["start"] + g["end"]) // 2
            b = (mid - start) * bins // span
            if 0 <= b < bins:
                counts[b] += 1
        return counts

    # ---- search -----------------------------------------------------------

    def search(self, q: str, category: str | None, limit: int) -> tuple[int, list[dict]]:
        q = q.strip()
        locus = parse_locus(q, self.lengths)
        if locus:
            return 1, [{"kind": "locus", "chrom": locus[0], "start": locus[1], "end": locus[2]}]

        ql = q.lower()
        tokens = ql.split()
        words = [re.compile(r"\b" + re.escape(t)) for t in tokens]

        def matches(text: str) -> bool:
            return all(w.search(text) for w in words)

        exact = self.by_symbol.get(q.upper(), []) if q else []
        scored = []
        for g, text in zip(self.genes, self._search_text):
            if category and category not in g["categories"]:
                continue
            if ql:
                if not all(t in text for t in tokens):
                    continue
                sym = g["symbol"].lower()
                if sym == ql:
                    score = 0
                elif sym.startswith(ql):
                    score = 1
                elif ql in sym:
                    score = 2
                else:
                    # Free-text hit: prefer whole-word matches, then genes where the
                    # query names more of their traits/conditions.
                    hits = sum(1 for d in g["diseases"] if matches(d.lower()))
                    hits += sum(5 for t in g["traits"] if matches(t["trait"].lower()))
                    if matches(g["description"].lower()) or matches(g.get("designations", "").lower()):
                        hits += 3
                    score = 3 - min(hits, 50) / 100 if hits else 4
            else:
                # Category browse: curated / most-annotated genes first.
                score = -len(g["traits"]) * 10 - min(len(g["diseases"]), 9)
            scored.append((score, g["symbol"], g))
        scored.sort(key=lambda t: (t[0], t[1]))
        seen = {id(g) for g in exact}
        results = list(exact) + [g for _, _, g in scored if id(g) not in seen]
        return len(results), [{"kind": "gene", **summary(g)} for g in results[:limit]]


def summary(g: dict) -> dict:
    return {k: g.get(k) for k in ("id", "symbol", "chrom", "start", "end", "strand", "description",
                                   "type", "categories", "blurb")}


def gene_detail(g: dict) -> dict:
    return {k: v for k, v in g.items()}


_LOCUS_RE = re.compile(r"^(chr)?([0-9]{1,2}|x|y|m|mt)(?::([\d,]+)(?:-([\d,]+))?)?$", re.I)


def parse_locus(q: str, lengths: dict[str, int]) -> tuple[str, int, int] | None:
    """Parse 'chr7', '7:117,559,590' or 'chr7:117559590-117668665'."""
    m = _LOCUS_RE.match(q.replace(" ", ""))
    if not m:
        return None
    name = m.group(2).upper()
    chrom = "chrM" if name in ("M", "MT") else f"chr{name}"
    if chrom not in lengths:
        return None
    length = lengths[chrom]
    if m.group(3) is None:
        return chrom, 0, length
    a = int(m.group(3).replace(",", ""))
    b = int(m.group(4).replace(",", "")) if m.group(4) else a + 100
    a, b = max(0, min(a, b) - 1), min(length, max(a, b))
    if m.group(4) is None:
        a, b = max(0, a - 100), min(length, a + 100)
    return chrom, a, b

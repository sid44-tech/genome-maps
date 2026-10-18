"""Plain-language explanations for genes and conditions (MedlinePlus Genetics)."""

from __future__ import annotations

import json
import re
from pathlib import Path

STOP = {
    "disease", "diseases", "type", "syndrome", "of", "the", "to", "susceptibility", "and", "due",
    "hereditary", "familial", "disorder", "disorders", "related", "with", "or", "in", "a", "deficiency",
}
MATCH_THRESHOLD = 0.6

TYPE_FALLBACK = {
    "protein-coding": "This gene holds the instructions for building a protein — one of the molecules that do "
                      "most of the work in your cells.",
    "ncRNA": "This gene doesn't make a protein. Instead it makes an RNA molecule that helps control how other "
             "genes are used.",
    "pseudo": "This is a “pseudogene”: an old copy of a gene that no longer works, like a fossil left in your DNA.",
    "snoRNA": "This gene makes a small RNA that helps cells build and fine-tune other molecules.",
    "tRNA": "This gene makes a transfer RNA, a small adapter molecule cells use when building proteins.",
    "rRNA": "This gene makes ribosomal RNA, part of the machinery that builds proteins.",
}
GENERIC = "Scientists are still working out exactly what this gene does."


def _tokens(s: str) -> set[str]:
    return {t for t in re.split(r"[^a-z0-9]+", s.lower()) if t and t not in STOP and not t.isdigit()}


class Plain:
    def __init__(self, path: Path):
        data = json.loads(path.read_text()) if path.exists() else {"genes": {}, "conditions": {}}
        self.genes: dict[str, dict] = data["genes"]
        self.conditions: dict[str, dict] = data["conditions"]
        self._condition_tokens = {
            name: [t for t in (_tokens(n) for n in [name, *c["synonyms"]]) if t]
            for name, c in self.conditions.items()
        }

    def gene_summary(self, symbol: str, gene_type: str) -> str:
        g = self.genes.get(symbol)
        if g and g["summary"]:
            return g["summary"]
        return TYPE_FALLBACK.get(gene_type, GENERIC)

    def condition(self, name: str) -> dict:
        c = self.conditions[name]
        return {"name": name, "summary": c["summary"], "url": c["url"], "inheritance": c["inheritance"]}

    def gene_conditions(self, symbol: str) -> list[dict]:
        g = self.genes.get(symbol)
        return [self.condition(n) for n in (g["conditions"] if g else []) if n in self.conditions]

    def match_conditions(self, gene: str | None, clinvar_conditions: list[str], limit: int = 3) -> list[dict]:
        """Map ClinVar's technical condition names to MedlinePlus conditions for the same gene."""
        if not gene:
            return []
        order = (self.genes.get(gene) or {}).get("conditions", [])
        cv = [t for t in (_tokens(c) for c in clinvar_conditions) if t]
        scored = []
        for name, c in self.conditions.items():
            if gene not in c["genes"]:
                continue
            best = max((len(tn & tc) / len(tn) for tn in self._condition_tokens[name] for tc in cv), default=0)
            if best >= MATCH_THRESHOLD:
                rank = order.index(name) if name in order else len(order)
                scored.append((-best, rank, name))
        return [self.condition(name) for _, _, name in sorted(scored)[:limit]]


_DRUG_RE = re.compile(r"^(.+?) response\b", re.I)


def drug_names(conditions: list[str]) -> list[str]:
    """'methotrexate response - Toxicity' -> 'methotrexate'."""
    out = []
    for c in conditions:
        m = _DRUG_RE.match(c.strip())
        if m:
            name = m.group(1).strip().lower()
            if name not in out:
                out.append(name)
    return out

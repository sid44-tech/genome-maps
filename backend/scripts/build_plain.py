"""Build backend/data/plain.json: plain-language gene and condition summaries.

Source: MedlinePlus Genetics (U.S. National Library of Medicine, public domain),
https://medlineplus.gov/download/ghr-summaries.xml -- written for patients and
families rather than scientists.

    python scripts/build_plain.py
"""

from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
SRC = DATA / "raw" / "ghr-summaries.xml"
H = "{http://www.w3.org/1999/xhtml}"


def paragraphs(el: ET.Element | None) -> list[str]:
    if el is None:
        return []
    out = []
    for p in el.iter(f"{H}p"):
        text = re.sub(r"\s+", " ", "".join(p.itertext())).strip()
        if text:
            out.append(text)
    return out


def main() -> int:
    root = ET.parse(SRC).getroot()
    ns = root.tag[1 : root.tag.index("}")]
    q = lambda tag: f"{{{ns}}}{tag}"  # noqa: E731

    def text_role(el: ET.Element, role: str) -> list[str]:
        for t in el.iter(q("text")):
            if t.findtext(q("text-role")) == role:
                return paragraphs(t.find(q("html")))
        return []

    genes, conditions = {}, {}
    for el in root.iter(q("gene-summary")):
        symbol = el.findtext(q("gene-symbol"))
        paras = text_role(el, "function")
        genes[symbol] = {
            "summary": paras[0] if paras else "",
            "more": paras[1:3],
            "url": el.findtext(q("ghr-page")),
            "conditions": [c.findtext(q("name")) for c in el.iter(q("related-health-condition"))],
        }
    for el in root.iter(q("health-condition-summary")):
        name = el.findtext(q("name"))
        paras = text_role(el, "description")
        conditions[name] = {
            "summary": paras[0] if paras else "",
            "url": el.findtext(q("ghr-page")),
            "inheritance": [i.findtext(q("code")) for i in el.iter(q("inheritance-pattern"))],
            "genes": [g.findtext(q("gene-symbol")) for g in el.iter(q("related-gene"))],
            "synonyms": [s.text for s in el.iter(q("synonym")) if s.text],
        }
    (DATA / "plain.json").write_text(json.dumps({"genes": genes, "conditions": conditions}, separators=(",", ":")))
    print(f"{len(genes)} gene and {len(conditions)} condition summaries -> plain.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())

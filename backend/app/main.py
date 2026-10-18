"""Genome Maps API.

The frontend requests data in fixed, power-of-two aligned tiles (like map tiles),
so every response here is a pure function of its query string and is cacheable.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Query, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from .dna_upload import UploadStore
from .genome import Genome, gene_detail, summary
from .plain import Plain
from .twobit import TwoBitFile

DATA = Path(os.environ.get("GENOME_DATA", Path(__file__).resolve().parent.parent / "data"))
MAX_SEQUENCE = 50_000
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
CACHE = "public, max-age=86400"

genome = Genome(DATA)
plain = Plain(DATA / "plain.json")
genome.add_blurbs(plain)
# Changes whenever the served data is rebuilt; clients put it in tile URLs so cached tiles never go stale.
DATA_VERSION = format(int(max((DATA / f).stat().st_mtime for f in ("genes.json", "genome.json", "plain.json"))), "x")
twobit = TwoBitFile(DATA / "raw" / "hg38.2bit")
uploads = UploadStore(DATA / "uploads.db", twobit, DATA / "raw" / "hg19ToHg38.over.chain.gz", genome.curated_snps,
                      DATA / "clinvar.db", plain)

app = FastAPI(title="Genome Maps API")
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "http://localhost:5173").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


def check_range(chrom: str, start: int, end: int) -> tuple[int, int]:
    if chrom not in genome.lengths:
        raise HTTPException(404, f"Unknown chromosome {chrom}")
    start, end = max(0, start), min(end, genome.lengths[chrom])
    if end <= start:
        raise HTTPException(400, "end must be greater than start")
    return start, end


@app.get("/api/genome")
def get_genome(response: Response):
    response.headers["Cache-Control"] = "no-cache"
    return {**genome.info, "categories": genome.categories, "dataVersion": DATA_VERSION}


@app.get("/api/genes")
def get_genes(response: Response, chrom: str, start: int, end: int):
    start, end = check_range(chrom, start, end)
    response.headers["Cache-Control"] = CACHE
    out = []
    for g in genome.genes_in(chrom, start, end):
        s = summary(g)
        s["exons"] = g["exons"]
        s["cdsStart"], s["cdsEnd"] = g["cdsStart"], g["cdsEnd"]
        out.append(s)
    return {"chrom": chrom, "start": start, "end": end, "genes": out}


@app.get("/api/genes/density")
def get_gene_density(response: Response, chrom: str, start: int, end: int, bins: int = Query(256, le=4096)):
    # Bins span the requested range even past the chromosome end, so tiles stay aligned.
    check_range(chrom, start, end)
    response.headers["Cache-Control"] = CACHE
    return {"chrom": chrom, "start": start, "end": end, "bins": genome.density(chrom, start, end, bins)}


@app.get("/api/genes/{gene_id}")
def get_gene(gene_id: int):
    if not 0 <= gene_id < len(genome.genes):
        raise HTTPException(404, "Gene not found")
    g = genome.genes[gene_id]
    p = plain.genes.get(g["symbol"], {})
    return {
        **gene_detail(g),
        "plain": {
            "summary": plain.gene_summary(g["symbol"], g["type"]),
            "more": p.get("more", []),
            "url": p.get("url"),
            "conditions": plain.gene_conditions(g["symbol"]),
        },
    }


@app.get("/api/sequence")
def get_sequence(response: Response, chrom: str, start: int, end: int):
    start, end = check_range(chrom, start, end)
    if end - start > MAX_SEQUENCE:
        raise HTTPException(400, f"Sequence requests are limited to {MAX_SEQUENCE} bp")
    response.headers["Cache-Control"] = CACHE
    return {"chrom": chrom, "start": start, "end": end, "sequence": twobit.fetch(chrom, start, end)}


@app.get("/api/search")
def search(q: str = "", category: str | None = None, limit: int = Query(25, le=500)):
    total, results = genome.search(q, category, limit)
    return {"total": total, "results": results}


# ---- personal DNA uploads -------------------------------------------------


@app.post("/api/uploads")
async def create_upload(file: UploadFile = File(...), build: str | None = Form(None)):
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File too large")
    if file.filename and file.filename.endswith(".zip"):
        raw = _unzip_first(raw)
    try:
        return uploads.ingest(file.filename or "upload", raw, build)
    except ValueError as e:
        raise HTTPException(422, str(e))


def _unzip_first(raw: bytes) -> bytes:
    import io
    import zipfile

    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        names = [n for n in z.namelist() if not n.endswith("/") and not n.startswith("__MACOSX")]
        if not names:
            raise HTTPException(422, "Zip archive is empty")
        return z.read(names[0])


@app.get("/api/uploads")
def list_uploads(sensitive: bool = False):
    return uploads.list(sensitive)


@app.get("/api/uploads/{upload_id}")
def get_upload(upload_id: str, sensitive: bool = False):
    u = uploads.get(upload_id, sensitive)
    if u is None:
        raise HTTPException(404, "Upload not found")
    return u


@app.delete("/api/uploads/{upload_id}")
def delete_upload(upload_id: str):
    if not uploads.delete(upload_id):
        raise HTTPException(404, "Upload not found")
    return {"deleted": upload_id}


@app.get("/api/uploads/{upload_id}/variants")
def get_variants(upload_id: str, chrom: str, start: int, end: int, bins: int | None = Query(None, le=4096),
                 sensitive: bool = False):
    if bins:
        check_range(chrom, start, end)
        return {"chrom": chrom, "start": start, "end": end, "bins": uploads.density(upload_id, chrom, start, end, bins)}
    start, end = check_range(chrom, start, end)
    return {"chrom": chrom, "start": start, "end": end, "variants": uploads.variants(upload_id, chrom, start, end, include_sensitive=sensitive)}

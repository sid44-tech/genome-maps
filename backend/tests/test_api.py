from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.dna_upload import detect, parse
from app.genome import parse_locus
from app.main import app, genome

client = TestClient(app)
SAMPLE = Path(__file__).resolve().parents[2] / "samples" / "sample_23andme.txt"


def test_genome_has_karyotype():
    data = client.get("/api/genome").json()
    names = [c["name"] for c in data["chromosomes"]]
    assert names[:2] == ["chr1", "chr2"] and "chrX" in names
    chr1 = data["chromosomes"][0]
    assert chr1["length"] == 248956422 and len(chr1["bands"]) > 50


def test_genes_in_viewport_includes_overlapping():
    # CFTR spans chr7:117,480,025-117,668,665; a window inside it must still return it.
    data = client.get("/api/genes", params={"chrom": "chr7", "start": 117_600_000, "end": 117_601_000}).json()
    assert "CFTR" in [g["symbol"] for g in data["genes"]]


def test_density_bins():
    data = client.get("/api/genes/density", params={"chrom": "chr1", "start": 0, "end": 248956422, "bins": 100}).json()
    assert len(data["bins"]) == 100 and sum(data["bins"]) > 1000


def test_sequence_and_limit():
    seq = client.get("/api/sequence", params={"chrom": "chr7", "start": 117559590, "end": 117559640}).json()
    assert seq["sequence"] == "TCTTTGGTGTTTCCTATGATGAATATAGATACAGAAGCGTCATCAAAGCA"
    assert client.get("/api/sequence", params={"chrom": "chr1", "start": 0, "end": 10**6}).status_code == 400


def test_search_symbol_disease_and_category():
    assert client.get("/api/search", params={"q": "brca1"}).json()["results"][0]["symbol"] == "BRCA1"
    cf = [r["symbol"] for r in client.get("/api/search", params={"q": "cystic fibrosis"}).json()["results"]]
    assert "CFTR" in cf
    appearance = client.get("/api/search", params={"category": "appearance", "limit": 100}).json()["results"]
    assert {"HERC2", "MC1R"} <= {r["symbol"] for r in appearance}


@pytest.mark.parametrize("q,expected", [
    ("chr7", ("chr7", 0, 159345973)),
    ("7:1,000-2,000", ("chr7", 999, 2000)),
    ("chrX:100", ("chrX", 0, 199)),
    ("BRCA1", None),
])
def test_parse_locus(q, expected):
    assert parse_locus(q, genome.lengths) == expected


def test_detect_formats():
    assert detect(["# build 37", "rsid\tchromosome\tposition\tgenotype"]) == ("23andme", "GRCh37")
    assert detect(["#AncestryDNA", "rsid\tchromosome\tposition\tallele1\tallele2"])[0] == "ancestry"
    assert detect(['"RSID","CHROMOSOME","POSITION","RESULT"'])[0] == "csv"
    assert detect(["##fileformat=VCFv4.2", "##contig=<ID=chr1,length=248956422>"]) == ("vcf", "GRCh38")


def test_parse_ancestry_chromosome_codes():
    calls = list(parse(["rs1\t23\t100\tA\tG", "rs2\t26\t50\tC\tC", "rs3\t1\t5\t0\t0"], "ancestry"))
    assert [(c.chrom, c.alleles) for c in calls] == [("chrX", "AG"), ("chrM", "CC"), ("chr1", "")]


def test_upload_roundtrip():
    with open(SAMPLE, "rb") as fh:
        res = client.post("/api/uploads", files={"file": ("sample.txt", fh, "text/plain")})
    assert res.status_code == 200, res.text
    up = res.json()
    assert up["build"] == "GRCh37" and up["counts"]["het"] > 1000
    eye = next(f for f in up["findings"] if f["rsid"] == "rs12913832")
    assert eye["copies"] == 2

    # HERC2 eye-color SNP lifted to GRCh38 chr15:28,120,472 (ref A, sample GG).
    v = client.get(f"/api/uploads/{up['id']}/variants",
                   params={"chrom": "chr15", "start": 28120000, "end": 28121000}).json()["variants"]
    herc2 = next(x for x in v if x["pos"] == 28120472)
    assert {k: herc2[k] for k in ("rsid", "ref", "genotype", "zygosity")} == {
        "rsid": "rs12913832", "ref": "A", "genotype": "GG", "zygosity": 2}
    assert herc2["clinvar"]["class"] == "risk"  # ClinVar: blue/non-blue eyes association

    assert client.delete(f"/api/uploads/{up['id']}").status_code == 200
    assert client.get(f"/api/uploads/{up['id']}").status_code == 404


# ---- ClinVar annotation ---------------------------------------------------

import sys  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from build_clinvar import classify  # noqa: E402


@pytest.mark.parametrize("sig,expected", [
    ("Pathogenic/Likely_pathogenic", "pathogenic"),
    ("Pathogenic|drug_response", "pathogenic"),
    ("Conflicting_classifications_of_pathogenicity|other|risk_factor", "risk"),
    ("Conflicting_classifications_of_pathogenicity", "conflicting"),
    ("drug_response", "drug"),
    ("Benign/Likely_benign", "benign"),
    ("Uncertain_significance", "vus"),
])
def test_classify_clinvar_significance(sig, expected):
    assert classify(sig) == expected


@pytest.fixture(scope="module")
def sample_upload():
    with open(SAMPLE, "rb") as fh:
        up = client.post("/api/uploads", files={"file": ("sample.txt", fh, "text/plain")}).json()
    yield up
    client.delete(f"/api/uploads/{up['id']}")


def test_clinvar_findings_on_upload(sample_upload):
    clinical = sample_upload["clinical"]
    hbb = next(f for f in clinical["findings"] if f["rsid"] == "rs334")
    assert (hbb["class"], hbb["gene"], hbb["copies"], hbb["alt"]) == ("pathogenic", "HBB", 1, "A")
    assert hbb["af"] and hbb["af"] < 0.01 and hbb["stars"] >= 2
    assert hbb["chrom"] == "chr11" and hbb["pos"] == 5227002
    assert not hbb["rare"]  # ~0.4% in ExAC: above the rare threshold
    # Pathogenic findings are ranked first.
    assert clinical["findings"][0]["class"] == "pathogenic"


def test_sensitive_findings_are_opt_in(sample_upload):
    uid = sample_upload["id"]
    default = sample_upload["clinical"]
    assert "APOE" not in {f["gene"] for f in default["findings"]}
    assert default["hiddenSensitive"] == 1

    opted = client.get(f"/api/uploads/{uid}", params={"sensitive": "true"}).json()["clinical"]
    apoe = next(f for f in opted["findings"] if f["gene"] == "APOE")
    assert apoe["sensitive"] and apoe["rsid"] == "rs429358"

    params = {"chrom": "chr19", "start": 44908000, "end": 44909000}
    v = client.get(f"/api/uploads/{uid}/variants", params=params).json()["variants"][0]
    assert v["hiddenSensitive"] and "clinvar" not in v
    v = client.get(f"/api/uploads/{uid}/variants", params={**params, "sensitive": "true"}).json()["variants"][0]
    assert v["clinvar"]["gene"] == "APOE"


def test_grch38_vcf_homozygous_clinvar_match():
    vcf = (
        "##fileformat=VCFv4.2\n"
        "##contig=<ID=chr6,length=170805979>\n"
        "##contig=<ID=chr1,length=248956422>\n"
        "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE\n"
        "chr6\t26092913\trs1800562\tG\tA\t.\tPASS\t.\tGT\t1/1\n"
    )
    up = client.post("/api/uploads", files={"file": ("me.vcf", vcf.encode(), "text/plain")}).json()
    try:
        assert up["build"] == "GRCh38"
        hfe = up["clinical"]["findings"][0]
        assert (hfe["gene"], hfe["copies"], hfe["class"]) == ("HFE", 2, "pathogenic")
    finally:
        client.delete(f"/api/uploads/{up['id']}")


# ---- plain language -------------------------------------------------------


def test_gene_detail_has_plain_summary_and_conditions():
    cftr = client.get("/api/search", params={"q": "CFTR"}).json()["results"][0]
    detail = client.get(f"/api/genes/{cftr['id']}").json()
    assert detail["plain"]["summary"].startswith("The CFTR gene provides instructions")
    assert "Cystic fibrosis" in [c["name"] for c in detail["plain"]["conditions"]]
    assert detail["plain"]["url"].startswith("https://medlineplus.gov/")


def test_search_results_carry_friendly_blurb():
    herc2 = client.get("/api/search", params={"q": "HERC2"}).json()["results"][0]
    assert herc2["blurb"].startswith("Eye color")


def test_genome_has_gene_counts_and_data_version():
    data = client.get("/api/genome").json()
    assert data["dataVersion"]
    assert data["chromosomes"][0]["geneCount"] > 1500  # chr1: ~2,000 protein-coding genes


def test_findings_map_to_plain_conditions(sample_upload):
    findings = sample_upload["clinical"]["findings"]
    hbb = next(f for f in findings if f["gene"] == "HBB")
    first = hbb["plain"]["conditions"][0]
    assert first["name"] == "Sickle cell disease" and first["inheritance"] == ["ar"]
    hfe = next(f for f in findings if f["gene"] == "HFE")
    assert hfe["plain"]["conditions"][0]["name"] == "Hereditary hemochromatosis"
    # Trait SNPs (eye color, lactose, folate...) are reported as traits, not health findings.
    assert not {"HERC2", "MCM6", "MTHFR"} & {f["gene"] for f in findings}
    eye = next(t for t in sample_upload["findings"] if t["rsid"] == "rs12913832")
    assert eye["trait"] == "Eye color" and "blue eyes" in eye["interpretation"]

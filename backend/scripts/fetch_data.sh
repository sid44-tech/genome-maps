#!/usr/bin/env bash
# Download the public reference data the API needs (~1 GB, mostly hg38.2bit and ClinVar).
set -euo pipefail
RAW="$(cd "$(dirname "$0")/.." && pwd)/data/raw"
mkdir -p "$RAW" && cd "$RAW"
fetch() { [ -s "$(basename "$1")" ] || curl -fL --progress-bar -O "$1"; }
fetch https://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/cytoBand.txt.gz
fetch https://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/refGene.txt.gz
fetch https://hgdownload.soe.ucsc.edu/goldenPath/hg19/liftOver/hg19ToHg38.over.chain.gz
fetch https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Mammalia/Homo_sapiens.gene_info.gz
fetch https://ftp.ncbi.nlm.nih.gov/pub/clinvar/gene_condition_source_id
fetch https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh38/clinvar.vcf.gz
fetch https://medlineplus.gov/download/ghr-summaries.xml
fetch https://hgdownload.soe.ucsc.edu/goldenPath/hg38/bigZips/hg38.2bit
echo "Reference data ready in $RAW"

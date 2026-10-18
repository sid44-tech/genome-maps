export type Band = [start: number, end: number, name: string, stain: string];

export interface Chromosome {
  name: string;
  length: number;
  bands: Band[];
  geneCount: number;
}

export interface Category {
  id: string;
  label: string;
}

export interface GenomeInfo {
  assembly: string;
  dataVersion: string;
  chromosomes: Chromosome[];
  categories: Category[];
}

export interface GeneSummary {
  id: number;
  symbol: string;
  chrom: string;
  start: number;
  end: number;
  strand: "+" | "-";
  description: string;
  type: string;
  categories: string[];
  /** One friendly line: a trait, or the conditions it's linked to. */
  blurb: string | null;
}

export interface Gene extends GeneSummary {
  exons: [number, number][];
  cdsStart: number;
  cdsEnd: number;
}

export interface GeneDetail extends Gene {
  transcript: string;
  geneId: number | null;
  synonyms: string[];
  mim: string | null;
  diseases: string[];
  traits: { category: string; trait: string }[];
  plain: {
    summary: string;
    more: string[];
    url: string | null;
    conditions: PlainCondition[];
  };
}

export interface PlainCondition {
  name: string;
  summary: string;
  url: string;
  /** MedlinePlus codes: ar, ad, xr, xd, ac, m, ... */
  inheritance: string[];
}

export type SearchResult =
  | ({ kind: "gene" } & GeneSummary)
  | { kind: "locus"; chrom: string; start: number; end: number };

export type ClinClass = "pathogenic" | "risk" | "drug" | "conflicting" | "other";

export interface ClinVarAnnotation {
  class: ClinClass;
  significance: string;
  stars: number;
  review: string;
  conditions: string[];
  gene: string | null;
  consequence: string | null;
  variationId: number;
  alt: string;
}

export interface Variant {
  pos: number; // 1-based GRCh38
  rsid: string;
  ref: string;
  genotype: string;
  zygosity: 1 | 2;
  clinvar?: ClinVarAnnotation;
  af?: number | null;
  afSource?: string | null;
  /** A ClinVar match in a sensitive gene, withheld until the viewer opts in. */
  hiddenSensitive?: boolean;
}

export interface ClinicalFinding {
  rsid: string;
  chrom: string;
  pos: number;
  gene: string | null;
  ref: string;
  alt: string;
  genotype: string;
  copies: number;
  class: ClinClass;
  significance: string;
  stars: number;
  review: string;
  conditions: string[];
  consequence: string | null;
  variationId: number;
  af: number | null;
  afSource: string | null;
  rare: boolean;
  sensitive: boolean;
  plain?: { conditions: PlainCondition[]; drugs: string[] };
}

export interface Finding {
  rsid: string;
  gene: string;
  trait: string;
  effectAllele: string;
  genotype: string;
  copies: number;
  interpretation: string;
}

export interface Upload {
  id: string;
  name: string;
  created: number;
  format: string;
  build: string;
  counts: Record<string, number>;
  variantsPerChrom: Record<string, number>;
  findings: Finding[];
  clinical?: {
    counts: Partial<Record<ClinClass, number>>;
    findings: ClinicalFinding[];
    clinvarMatches: number;
    hiddenSensitive: number;
  };
}

async function getJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* not JSON */
    }
    throw new Error(detail);
  }
  return res.json();
}

const qs = (p: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(p).filter(([, v]) => v !== undefined && v !== "") as [string, string][],
  ).toString();

export const api = {
  // Always revalidate: it carries the data version that keys every cached tile.
  genome: () => getJSON<GenomeInfo>("/api/genome", { cache: "no-cache" }),
  gene: (id: number) => getJSON<GeneDetail>(`/api/genes/${id}`),
  search: (q: string, category?: string, limit = 25) =>
    getJSON<{ total: number; results: SearchResult[] }>(`/api/search?${qs({ q, category, limit })}`),
  uploads: (sensitive = false) => getJSON<Upload[]>(`/api/uploads?${qs({ sensitive: sensitive ? "true" : undefined })}`),
  upload: (file: File, build?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (build) form.append("build", build);
    return getJSON<Upload>("/api/uploads", { method: "POST", body: form });
  },
  deleteUpload: (id: string) => getJSON(`/api/uploads/${id}`, { method: "DELETE" }),
};

/**
 * Map-style tile cache. Data is requested in power-of-two aligned tiles so that
 * panning re-uses what is already loaded and only the newly exposed tiles are
 * fetched. Keeps the most recently used tiles, evicting the oldest.
 */
export class TileCache {
  private data = new Map<string, unknown>();
  private pending = new Map<string, Promise<void>>();

  constructor(
    private onLoad: () => void,
    private max = 600,
  ) {}

  get<T>(url: string): T | undefined {
    const hit = this.data.get(url);
    if (hit !== undefined) {
      // refresh LRU position
      this.data.delete(url);
      this.data.set(url, hit);
      return hit as T;
    }
    if (!this.pending.has(url)) {
      this.pending.set(
        url,
        getJSON<T>(url)
          .then((v) => {
            this.data.set(url, v);
            while (this.data.size > this.max) this.data.delete(this.data.keys().next().value!);
            this.onLoad();
          })
          .catch(() => {})
          .finally(() => this.pending.delete(url)),
      );
    }
    return undefined;
  }

  peek<T>(url: string): T | undefined {
    return this.data.get(url) as T | undefined;
  }

  get loading() {
    return this.pending.size;
  }
}

/** Starts of aligned tiles of `size` covering [start, end). */
export function tileStarts(start: number, end: number, size: number): number[] {
  const out: number[] = [];
  for (let t = Math.floor(Math.max(0, start) / size) * size; t < end; t += size) out.push(t);
  return out;
}

/** Set from /api/genome; part of every cacheable tile URL so a data rebuild busts browser caches. */
let dataVersion = "";
export const setDataVersion = (v: string) => {
  dataVersion = v;
};

export const tileUrl = {
  genes: (chrom: string, start: number, size: number) =>
    `/api/genes?${qs({ chrom, start, end: start + size, v: dataVersion })}`,
  density: (chrom: string, start: number, size: number, bins: number) =>
    `/api/genes/density?${qs({ chrom, start, end: start + size, bins, v: dataVersion })}`,
  sequence: (chrom: string, start: number, size: number) =>
    `/api/sequence?${qs({ chrom, start, end: start + size })}`,
  variants: (upload: string, chrom: string, start: number, size: number, bins?: number, sensitive = false) =>
    `/api/uploads/${upload}/variants?${qs({ chrom, start, end: start + size, bins, sensitive: sensitive ? "true" : undefined })}`,
};

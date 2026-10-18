/** Colors shared by the karyotype (SVG) and chromosome map (canvas). */

export const STAIN: Record<string, string> = {
  gneg: "#f3f1ec",
  gpos25: "#c9c5bd",
  gpos50: "#a29d94",
  gpos75: "#77726a",
  gpos100: "#4a4640",
  acen: "#d8685a",
  gvar: "#b7c4d6",
  stalk: "#93a6bf",
};

export const BASE: Record<string, string> = {
  A: "#3aa655",
  C: "#2f7bd8",
  G: "#e8a317",
  T: "#d9483b",
  N: "#9aa0a6",
};

export const COMPLEMENT: Record<string, string> = { A: "T", C: "G", G: "C", T: "A", N: "N" };

/** Category -> color, used for gene bodies, chips and pins. Order matters: first match wins. */
export const CATEGORY_COLORS: [string, string][] = [
  ["appearance", "#a142f4"],
  ["senses", "#f06292"],
  ["nutrition", "#2e9e5b"],
  ["pharmacogenomics", "#0b8fa8"],
  ["fitness", "#e37400"],
  ["blood-immunity", "#c5221f"],
  ["cancer", "#b3261e"],
  ["cardiovascular", "#d93025"],
  ["neurological", "#7b1fa2"],
  ["metabolic", "#9e6a03"],
  ["vision-hearing", "#1967d2"],
  ["disease", "#d93025"],
];

export function categoryColor(id: string): string {
  return CATEGORY_COLORS.find(([c]) => c === id)?.[1] ?? "#1a73e8";
}

export function geneColor(categories: string[], type: string): string {
  for (const [cat, color] of CATEGORY_COLORS) {
    if (cat === "disease") break; // trait categories outrank generic disease subtypes below
    if (categories.includes(cat)) return color;
  }
  if (categories.includes("disease")) return "#d93025";
  if (type === "protein-coding") return "#1a73e8";
  if (type.startsWith("ncRNA") || type === "snoRNA" || type === "tRNA" || type === "rRNA") return "#12857a";
  if (type === "pseudo") return "#9aa0a6";
  return "#5f6368";
}

export const VARIANT = { het: "#f29900", homAlt: "#d93025" };

/** ClinVar classes: color and plain-language label. */
export const CLIN: Record<string, { color: string; label: string }> = {
  pathogenic: { color: "#8e24aa", label: "Pathogenic" },
  risk: { color: "#1967d2", label: "Risk factor / association" },
  drug: { color: "#0b8fa8", label: "Drug response" },
  conflicting: { color: "#80868b", label: "Conflicting evidence" },
  other: { color: "#80868b", label: "Other" },
};

export function formatAf(af: number | null | undefined, source?: string | null): string {
  if (af == null) return "Population frequency unknown";
  const pct = af * 100;
  const s = pct >= 1 ? pct.toFixed(1) : pct >= 0.01 ? pct.toFixed(2) : "<0.01";
  return `Allele frequency ${s}%${source ? ` (${source})` : ""}`;
}

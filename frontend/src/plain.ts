/** Plain-language wording shared across the UI. Written for people, not bioinformaticians. */

import { useState } from "react";
import { ClinicalFinding } from "./api";

/** A boolean preference remembered in this browser (falls back to memory if storage is blocked). */
export function useStoredFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? initial : v === "1";
    } catch {
      return initial;
    }
  });
  const set = (v: boolean) => {
    setValue(v);
    try {
      localStorage.setItem(key, v ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  };
  return [value, set];
}

/** 302,000 -> "302 thousand"; 3.1e9 -> "3.1 billion". */
export function friendlyCount(n: number): string {
  const a = Math.abs(n);
  const fmt = (x: number) => (x >= 100 ? Math.round(x).toString() : (+x.toPrecision(2)).toString());
  if (a >= 1e9) return `${fmt(n / 1e9)} billion`;
  if (a >= 1e6) return `${fmt(n / 1e6)} million`;
  if (a >= 1e4) return `${fmt(n / 1e3)} thousand`;
  return Math.round(n).toLocaleString("en-US");
}

export const letters = (n: number) => `${friendlyCount(n)} DNA letter${Math.round(n) === 1 ? "" : "s"}`;

/** Zoom "stops", like street / city / country on a map. */
export const LEVELS = [
  { id: "genome", label: "All chromosomes", hint: "Your whole genome" },
  { id: "chromosome", label: "Chromosome", hint: "One chromosome, end to end" },
  { id: "neighborhood", label: "Neighborhood", hint: "A stretch with many genes" },
  { id: "gene", label: "Gene", hint: "A single gene" },
  { id: "letters", label: "DNA letters", hint: "Individual A, C, G, T letters" },
] as const;
export type LevelId = (typeof LEVELS)[number]["id"];

export const GLOSSARY: [string, string][] = [
  ["DNA", "The instruction manual for building and running your body, written in a 4-letter alphabet: A, C, G and T."],
  ["Genome", "All of your DNA together — about 3 billion letters, packed into every cell."],
  ["Chromosome", "A long strand of DNA, tightly coiled. Most people have 23 pairs: one set from each parent."],
  ["Gene", "A section of DNA that holds the recipe for one thing your body makes, often a protein."],
  ["Reference genome", "A standard human DNA sequence that scientists use as a point of comparison. It isn't “normal” or “ideal” — just a shared yardstick."],
  ["Variant", "A spot where your DNA letters differ from the reference genome. Everyone has millions, and nearly all are harmless."],
  ["Two copies", "You have two copies of most chromosomes — one from each parent — so each spot has two letters."],
  ["Carrier", "Someone with one copy of a variant for a condition that needs two copies. Carriers usually don't have the condition but can pass the variant on."],
];

// ---- health findings ------------------------------------------------------

export const CLIN_PLAIN: Record<string, { badge: string; color: string }> = {
  pathogenic: { badge: "Linked to a health condition", color: "#8e24aa" },
  risk: { badge: "May affect your risk", color: "#1967d2" },
  drug: { badge: "May affect medicines", color: "#0b8fa8" },
  conflicting: { badge: "Scientists disagree", color: "#80868b" },
  other: { badge: "Other", color: "#80868b" },
};

const EVIDENCE = ["Limited evidence", "Some evidence", "Good evidence", "Strong evidence (expert panel)",
  "Strongest evidence (medical guideline)"];
export const evidenceLabel = (stars: number) => EVIDENCE[Math.max(0, Math.min(4, stars))];

/** ClinVar sometimes shouts: "METHEMOGLOBINEMIA, BETA TYPE" -> "Methemoglobinemia, beta type". */
export function tidyName(s: string): string {
  if (s !== s.toUpperCase()) return s;
  const lower = s.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function findingTitle(f: ClinicalFinding): string {
  if (f.plain?.conditions.length) return f.plain.conditions[0].name;
  if (f.class === "drug" && f.plain?.drugs.length) return `Response to ${f.plain.drugs.join(", ")}`;
  return f.conditions[0] ? tidyName(f.conditions[0]) : `${f.gene} variant`;
}

/** "About 1 in 110 people carry this" from an allele frequency. */
export function howCommon(af: number | null): string {
  if (af == null) return "We don't know how common this is.";
  const carriers = 1 - (1 - af) ** 2; // share of people with at least one copy
  if (carriers >= 0.2) return `Very common — about ${Math.round(carriers * 100)}% of people carry it.`;
  const n = 1 / carriers;
  const nice = n < 20 ? Math.round(n) : n < 200 ? Math.round(n / 5) * 5 : n < 2000 ? Math.round(n / 50) * 50
    : Math.round(n / 500) * 500;
  return `About 1 in ${nice.toLocaleString("en-US")} people carry this.`;
}

/** The "what does this mean for me" sentence for a finding. */
export function whatItMeans(f: ClinicalFinding): string {
  const condition = findingTitle(f);
  const inh = f.plain?.conditions[0]?.inheritance[0];
  if (f.class === "drug") {
    const drugs = f.plain?.drugs.length ? f.plain.drugs.join(", ") : "some medicines";
    return `This may change how your body responds to ${drugs}. Never change a medication without talking to your doctor or pharmacist.`;
  }
  if (f.class === "risk") {
    return `This variant is associated with a different chance of ${condition.toLowerCase()}. It's one factor among many — other genes, lifestyle and environment matter too.`;
  }
  if (inh === "ar" || inh === "xr") {
    return f.copies >= 2
      ? `You have two copies. ${condition} usually happens when someone has two copies, so this is worth discussing with a doctor or genetic counselor.`
      : `You carry one copy, which makes you a carrier. ${condition} usually needs two copies, so carriers typically don't have it — but they can pass the copy on to their children.`;
  }
  if (inh === "ad" || inh === "xd") {
    return `For ${condition.toLowerCase()}, one copy can be enough to raise the chance of having it. Consider confirming this with a clinical test.`;
  }
  return "This variant has been linked to a health condition. If you have concerns, talk to a doctor or genetic counselor.";
}

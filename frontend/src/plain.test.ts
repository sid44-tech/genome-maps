import { describe, expect, it } from "vitest";
import { ClinicalFinding } from "./api";
import { findingTitle, friendlyCount, howCommon, tidyName, whatItMeans } from "./plain";

const finding = (over: Partial<ClinicalFinding>): ClinicalFinding => ({
  rsid: "rs334", chrom: "chr11", pos: 5227002, gene: "HBB", ref: "T", alt: "A", genotype: "AT", copies: 1,
  class: "pathogenic", significance: "Pathogenic", stars: 2, review: "", conditions: ["Hb SS disease"],
  consequence: null, variationId: 1, af: 0.00438, afSource: "ExAC", rare: false, sensitive: false,
  plain: { conditions: [{ name: "Sickle cell disease", summary: "", url: "", inheritance: ["ar"] }], drugs: [] },
  ...over,
});

describe("plain-language helpers", () => {
  it("formats big numbers in words", () => {
    expect(friendlyCount(3_100_000_000)).toBe("3.1 billion");
    expect(friendlyCount(302_000)).toBe("302 thousand");
    expect(friendlyCount(91)).toBe("91");
  });

  it("turns allele frequency into 1-in-N carriers", () => {
    expect(howCommon(0.00438)).toBe("About 1 in 115 people carry this.");
    expect(howCommon(0.3)).toMatch(/^Very common — about 51%/);
    expect(howCommon(null)).toMatch(/don't know/);
  });

  it("explains carrier status for recessive conditions", () => {
    expect(whatItMeans(finding({}))).toMatch(/^You carry one copy, which makes you a carrier/);
    expect(whatItMeans(finding({ copies: 2 }))).toMatch(/^You have two copies/);
  });

  it("frames drug-response findings around medicines", () => {
    const f = finding({ class: "drug", plain: { conditions: [], drugs: ["warfarin"] } });
    expect(findingTitle(f)).toBe("Response to warfarin");
    expect(whatItMeans(f)).toMatch(/responds to warfarin.*doctor or pharmacist/);
  });

  it("calms ClinVar's all-caps names", () => {
    expect(tidyName("METHEMOGLOBINEMIA, BETA TYPE")).toBe("Methemoglobinemia, beta type");
    expect(tidyName("Sickle cell disease")).toBe("Sickle cell disease");
  });
});

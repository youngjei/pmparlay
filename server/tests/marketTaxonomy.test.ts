import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRelationshipMetadata, normalizeMarketTaxonomy } from "../marketTaxonomy";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("market taxonomy keyword matching", () => {
  it("preserves category scoring and deterministic asset relationships", () => {
    const taxonomy = normalizeMarketTaxonomy({
      question: "Will Bitcoin outperform Ethereum after the Federal Reserve decision?",
      sourceCategory: "Crypto",
      sourceTags: ["BTC", "Ethereum"]
    });

    expect(taxonomy).toMatchObject({
      category: "Crypto",
      sourceTags: ["BTC", "Crypto", "Ethereum"],
      matchedSignals: [
        "source_category:crypto",
        "source_tag:btc",
        "source_tag:crypto",
        "source_tag:ethereum",
        "question:bitcoin"
      ]
    });

    const relationships = buildRelationshipMetadata({
      id: "bitcoin-ethereum-yes",
      marketId: "bitcoin-ethereum",
      question: "Will Bitcoin outperform Ethereum after the Federal Reserve decision?",
      category: taxonomy.category,
      outcome: "Yes",
      price: 0.5,
      source: "polymarket",
      sourceTags: taxonomy.sourceTags,
      taxonomy,
      eventGroupKey: "polymarket:event:bitcoin-ethereum",
      eventSlug: "bitcoin-ethereum",
      eventTitle: "Bitcoin Ethereum"
    });

    expect(relationships.hard).toMatchObject([
      {
        type: "same_event",
        key: "polymarket:event:bitcoin-ethereum",
        evidence: ["bitcoin-ethereum"]
      }
    ]);
    expect(relationships.soft.filter((relationship) => relationship.type === "asset")).toMatchObject([
      { key: "asset:bitcoin", evidence: ["Will Bitcoin outperform Ethereum after the Federal Reserve decision?"] },
      { key: "asset:ethereum", evidence: ["Will Bitcoin outperform Ethereum after the Federal Reserve decision?"] }
    ]);
  });

  it("normalizes a synthetic taxonomy batch once per input signal", () => {
    const inputs = Array.from({ length: 500 }, (_, index) => ({
      question: `Will Bitcoin close above ${100_000 + index} dollars?`,
      eventSlug: `bitcoin-price-${index}`,
      marketUrl: `https://polymarket.com/event/bitcoin-price-${index}`
    }));
    const replaceSpy = vi.spyOn(String.prototype, "replace");

    const categories = inputs.map((input) => normalizeMarketTaxonomy(input).category);

    expect(categories).toEqual(Array.from({ length: inputs.length }, () => "Crypto"));
    // normalizedText performs two replacements; each of the three signals is normalized once.
    expect(replaceSpy).toHaveBeenCalledTimes(inputs.length * 3 * 2);
  });
});

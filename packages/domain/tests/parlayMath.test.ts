import { describe, expect, it } from "vitest";
import { calculateParlay, clampProbability, formatCents } from "../src/parlayMath";
import type { ParlayLeg } from "../src/types";

function leg(id: string, price: number): ParlayLeg {
  return {
    id,
    marketId: id,
    question: id,
    category: "Test",
    outcome: "Yes",
    price,
    source: "polymarket",
    addedAt: 1
  };
}

describe("calculateParlay", () => {
  it("compounds probabilities and applies the offered spread", () => {
    const result = calculateParlay([leg("a", 0.5), leg("b", 0.25)], 100, {
      houseEdgeBps: 1_000,
      operationFeePerLegUsd: 1
    });

    expect(result.impliedProbability).toBeCloseTo(0.125);
    expect(result.fairDecimalOdds).toBeCloseTo(8);
    expect(result.offeredDecimalOdds).toBeCloseTo(7.2);
    expect(result.grossPayout).toBeCloseTo(720);
    expect(result.operationFee).toBe(2);
    expect(result.totalCost).toBe(102);
    expect(result.netProfit).toBeCloseTo(618);
  });

  it("does not charge operation fees when there are no legs", () => {
    const result = calculateParlay([], 100);

    expect(result.impliedProbability).toBe(0);
    expect(result.grossPayout).toBe(0);
    expect(result.operationFee).toBe(0);
    expect(result.totalCost).toBe(0);
  });
});

describe("probability formatting", () => {
  it("clamps valid quote probabilities to the supported range", () => {
    expect(clampProbability(0)).toBe(0.01);
    expect(clampProbability(0.995)).toBe(0.99);
    expect(clampProbability(Number.NaN)).toBe(0);
  });

  it("formats market prices in cents with useful precision", () => {
    expect(formatCents(0.0052)).toBe("0.52¢");
    expect(formatCents(0.028)).toBe("2.8¢");
    expect(formatCents(0.68)).toBe("68¢");
  });
});

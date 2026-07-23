import { describe, expect, it } from "vitest";
import { assessTicketRisk, DEFAULT_RISK_POLICY, type RiskPolicy } from "../src/riskEngine";
import type { ParlayLeg } from "../src/types";

function leg(overrides: Partial<ParlayLeg> & Pick<ParlayLeg, "id" | "price">): ParlayLeg {
  return {
    marketId: overrides.id,
    question: overrides.question || overrides.id,
    category: overrides.category || "Test",
    outcome: overrides.outcome || "Yes",
    source: "polymarket",
    volume: 1_000_000,
    liquidity: 1_000_000,
    addedAt: 1,
    ...overrides
  };
}

const relaxedPolicy: RiskPolicy = {
  ...DEFAULT_RISK_POLICY,
  maxStakeUsd: 100,
  manualReviewStakeUsd: 1_000,
  maxGrossPayoutUsd: 100_000,
  maxPayoutMultiple: 1_000
};

describe("assessTicketRisk", () => {
  it("accepts clean liquid baskets inside launch limits", () => {
    const result = assessTicketRisk(
      [leg({ id: "a", price: 0.5, category: "Crypto" }), leg({ id: "b", price: 0.4, category: "Politics" })],
      25,
      relaxedPolicy
    );

    expect(result.decision).toBe("accept");
    expect(result.spreadBps).toBe(700);
    expect(result.checks).toContainEqual({
      level: "ok",
      label: "Risk checks passed",
      detail: "This basket is inside current launch limits."
    });
  });

  it("blocks stakes above the policy cap", () => {
    const result = assessTicketRisk([leg({ id: "a", price: 0.5 }), leg({ id: "b", price: 0.4 })], 26);

    expect(result.decision).toBe("reject");
    expect(result.checks.some((check) => check.label === "Stake limit" && check.level === "block")).toBe(true);
  });

  it("blocks baskets that would not pay more than the amount due", () => {
    const result = assessTicketRisk([leg({ id: "a", price: 0.95 }), leg({ id: "b", price: 0.95 })], 25, relaxedPolicy);

    expect(result.decision).toBe("reject");
    expect(result.checks.some((check) => check.label === "No upside" && check.level === "block")).toBe(true);
  });

  it("does not block positive-upside favorite baskets just because a single leg pays more", () => {
    const legs = [
      leg({ id: "newsom-nominee-no", price: 0.8, question: "Will Gavin Newsom win the 2028 Democratic presidential nomination?", outcome: "No" }),
      leg({ id: "newsom-president-no", price: 0.88, question: "Will Gavin Newsom win the 2028 US Presidential Election?", outcome: "No" }),
      leg({ id: "usa-world-cup-no", price: 0.975, question: "Will USA win the 2026 FIFA World Cup?", outcome: "No" })
    ];

    expect(assessTicketRisk(legs, 35, relaxedPolicy).decision).not.toBe("reject");
    expect(assessTicketRisk(legs, 55, relaxedPolicy).decision).not.toBe("reject");
  });

  it("caps high calculated spread and marks the quote for review", () => {
    const legs = [
      leg({ id: "btc-1", price: 0.5, category: "Crypto", question: "Bitcoin up?" }),
      leg({ id: "btc-2", price: 0.5, category: "Crypto", question: "Will BTC ETF pass?" }),
      leg({ id: "btc-3", price: 0.5, category: "Crypto", question: "Bitcoin above 100k?" }),
      leg({ id: "btc-4", price: 0.5, category: "Crypto", question: "BTC dominance rises?" })
    ];

    const result = assessTicketRisk(legs, 25, {
      ...relaxedPolicy,
      baseSpreadBps: 1_000,
      maxSpreadBps: 1_200
    });

    expect(result.decision).toBe("review");
    expect(result.spreadWasCapped).toBe(true);
    expect(result.spreadBps).toBe(1_200);
  });
});

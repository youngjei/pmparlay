import { describe, expect, it } from "vitest";
import {
  calculateSettlementPayout,
  SETTLEMENT_PAYOUT_CALCULATION_VERSION,
  type SettlementPayoutInput,
  type SettlementPayoutLegStatus
} from "../settlementPayout";

function input(
  statuses: readonly SettlementPayoutLegStatus[],
  options: { stake?: bigint; offered?: bigint; prices?: readonly bigint[] } = {}
): SettlementPayoutInput {
  const prices = options.prices || statuses.map(() => 5_000n);
  return {
    stakeMicroUsdc: options.stake ?? 10_000_000n,
    originalOfferedPayoutMicroUsdc: options.offered ?? 100_000_000n,
    legs: statuses.map((status, index) => ({
      id: `leg-${index + 1}`,
      frozenPriceBps: prices[index],
      status
    }))
  };
}

describe("calculateSettlementPayout", () => {
  it.each([
    ["lost only", ["lost"]],
    ["lost before pending", ["lost", "pending"]],
    ["lost after disputed", ["disputed", "lost"]],
    ["lost with won and voided", ["won", "voided", "lost"]]
  ] as const)("makes any lost leg final with zero payout: %s", (_name, statuses) => {
    const result = calculateSettlementPayout(input(statuses));

    expect(result).toMatchObject({ isFinal: true, finalStatus: "lost", finalPayoutMicroUsdc: "0" });
    expect(result.lostLegIds).toEqual(statuses.flatMap((status, index) => (status === "lost" ? [`leg-${index + 1}`] : [])));
  });

  it.each([
    ["pending only", ["pending"]],
    ["disputed only", ["disputed"]],
    ["won and pending", ["won", "pending"]],
    ["voided and disputed", ["voided", "disputed"]],
    ["won, voided, pending, disputed", ["won", "voided", "pending", "disputed"]]
  ] as const)("keeps unresolved non-losing combinations non-final: %s", (_name, statuses) => {
    const result = calculateSettlementPayout(input(statuses));

    expect(result).toMatchObject({ isFinal: false, finalStatus: "pending", finalPayoutMicroUsdc: null });
  });

  it.each([
    [["voided"]],
    [["voided", "voided"]],
    [["voided", "voided", "voided"]]
  ] as const)("returns only the stake when every leg is voided: %j", (statuses) => {
    const result = calculateSettlementPayout(input(statuses, { stake: 12_345_678n, offered: 999_999_999n }));

    expect(result).toMatchObject({ isFinal: true, finalStatus: "voided", finalPayoutMicroUsdc: "12345678" });
  });

  it("returns the original offered payout when every leg wins", () => {
    const result = calculateSettlementPayout(input(["won", "won"], { offered: 72_000_001n }));

    expect(result).toMatchObject({ isFinal: true, finalStatus: "won", finalPayoutMicroUsdc: "72000001" });
  });

  it("removes one voided leg using its frozen quoted price", () => {
    const result = calculateSettlementPayout(
      input(["won", "voided", "won"], { offered: 100_000_000n, prices: [2_000n, 4_000n, 8_000n] })
    );

    expect(result.finalPayoutMicroUsdc).toBe("40000000");
    expect(result.voidedLegIds).toEqual(["leg-2"]);
  });

  it("combines multiple void factors before flooring exactly once", () => {
    const result = calculateSettlementPayout(
      input(["voided", "won", "voided"], { stake: 1n, offered: 101n, prices: [3_333n, 5_000n, 3_333n] })
    );

    expect(result.finalPayoutMicroUsdc).toBe("11");
  });

  it("supports a single winning leg after every other leg voids", () => {
    const result = calculateSettlementPayout(
      input(["voided", "won"], { stake: 10_000_000n, offered: 50_000_000n, prices: [6_000n, 3_000n] })
    );

    expect(result).toMatchObject({ finalStatus: "won", finalPayoutMicroUsdc: "30000000" });
  });

  it("floors a winning reduced payout at the original stake", () => {
    const result = calculateSettlementPayout(
      input(["won", "voided"], { stake: 10_000_000n, offered: 10_000_001n, prices: [5_000n, 9_000n] })
    );

    expect(result.finalPayoutMicroUsdc).toBe("10000000");
  });

  it("applies the stake floor to an all-won quote whose original payout is below stake", () => {
    const result = calculateSettlementPayout(input(["won"], { stake: 10n, offered: 9n }));

    expect(result.finalPayoutMicroUsdc).toBe("10");
  });

  it("accepts boundary prices without Number conversion", () => {
    const zeroPriceVoid = calculateSettlementPayout(input(["won", "voided"], { stake: 7n, offered: 100n, prices: [1n, 0n] }));
    const fullPriceVoid = calculateSettlementPayout(input(["won", "voided"], { stake: 7n, offered: 100n, prices: [1n, 10_000n] }));

    expect(zeroPriceVoid.finalPayoutMicroUsdc).toBe("7");
    expect(fullPriceVoid.finalPayoutMicroUsdc).toBe("100");
  });

  it("returns complete deterministic calculation evidence in quote-leg order", () => {
    const result = calculateSettlementPayout(
      input(["won", "voided", "pending", "disputed", "lost"], {
        stake: 1_000_000n,
        offered: 9_000_000n,
        prices: [1_111n, 2_222n, 3_333n, 4_444n, 5_555n]
      })
    );

    expect(result).toEqual({
      version: SETTLEMENT_PAYOUT_CALCULATION_VERSION,
      isFinal: true,
      finalStatus: "lost",
      stakeMicroUsdc: "1000000",
      originalOfferedPayoutMicroUsdc: "9000000",
      finalPayoutMicroUsdc: "0",
      wonLegIds: ["leg-1"],
      voidedLegIds: ["leg-2"],
      lostLegIds: ["leg-5"],
      pendingLegIds: ["leg-3"],
      disputedLegIds: ["leg-4"],
      frozenPricesBps: [
        { legId: "leg-1", priceBps: "1111" },
        { legId: "leg-2", priceBps: "2222" },
        { legId: "leg-3", priceBps: "3333" },
        { legId: "leg-4", priceBps: "4444" },
        { legId: "leg-5", priceBps: "5555" }
      ],
      roundingPolicy: "floor-after-combined-void-factor-then-stake-floor",
      operationFeePolicy: "excluded-from-payout-and-retained"
    });
  });

  it.each([
    ["empty legs", input([]), "invalid_settlement_legs_empty"],
    ["zero stake", input(["won"], { stake: 0n }), "invalid_settlement_stake"],
    ["negative stake", input(["won"], { stake: -1n }), "invalid_settlement_stake"],
    ["negative original payout", input(["won"], { offered: -1n }), "invalid_settlement_original_payout"],
    ["negative price", input(["won"], { prices: [-1n] }), "invalid_settlement_leg_price"],
    ["price above 10000", input(["won"], { prices: [10_001n] }), "invalid_settlement_leg_price"]
  ])("rejects malformed input: %s", (_name, malformed, errorCode) => {
    expect(() => calculateSettlementPayout(malformed)).toThrow(errorCode);
  });

  it("rejects duplicate leg IDs", () => {
    const malformed = input(["won", "voided"]);
    malformed.legs = [malformed.legs[0], { ...malformed.legs[1], id: malformed.legs[0].id }];

    expect(() => calculateSettlementPayout(malformed)).toThrow("duplicate_settlement_leg_id");
  });

  it.each(["", "   "])("rejects blank leg ID %j", (id) => {
    const malformed = input(["won"]);
    malformed.legs = [{ ...malformed.legs[0], id }];

    expect(() => calculateSettlementPayout(malformed)).toThrow("invalid_settlement_leg_id");
  });

  it("rejects an unknown status at runtime", () => {
    const malformed = input(["won"]);
    malformed.legs = [{ ...malformed.legs[0], status: "canceled" as SettlementPayoutLegStatus }];

    expect(() => calculateSettlementPayout(malformed)).toThrow("invalid_settlement_leg_status");
  });

  it("rejects non-bigint monetary and price values at runtime", () => {
    expect(() => calculateSettlementPayout({ ...input(["won"]), stakeMicroUsdc: 1 as unknown as bigint })).toThrow(
      "invalid_settlement_stake"
    );
    expect(() =>
      calculateSettlementPayout({ ...input(["won"]), originalOfferedPayoutMicroUsdc: "1" as unknown as bigint })
    ).toThrow("invalid_settlement_original_payout");
    const malformed = input(["won"]);
    malformed.legs = [{ ...malformed.legs[0], frozenPriceBps: 5_000 as unknown as bigint }];
    expect(() => calculateSettlementPayout(malformed)).toThrow("invalid_settlement_leg_price");
  });
});

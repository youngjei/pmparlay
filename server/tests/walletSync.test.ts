import { describe, expect, it } from "vitest";
import { canCommitWalletSyncAttempt } from "../../src/walletSync";

describe("wallet sync generation guard", () => {
  it("rejects aborted and superseded sync attempts", () => {
    expect(canCommitWalletSyncAttempt(2, 1, false)).toBe(false);
    expect(canCommitWalletSyncAttempt(2, 2, true)).toBe(false);
    expect(canCommitWalletSyncAttempt(2, 2, false)).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LP_VAULT_ACCOUNTING_POLL_INTERVAL_MS,
  lpVaultAccountingPollIntervalMs,
  processDueLpVaultAccountingCycle
} from "../workers/lpVaultAccountingWorker";

describe("LP vault accounting worker", () => {
  it("delegates scheduling and UTC cutoff authority to PostgreSQL repository code", async () => {
    const runCycle = vi.fn().mockResolvedValue({ status: "already_closed", cutoffDate: "2026-09-10" });

    await expect(processDueLpVaultAccountingCycle({ runCycle })).resolves.toEqual({
      status: "already_closed",
      cutoffDate: "2026-09-10"
    });
    expect(runCycle).toHaveBeenCalledOnce();
    expect(runCycle).toHaveBeenCalledWith();
  });

  it("uses a bounded poll interval", () => {
    expect(lpVaultAccountingPollIntervalMs(undefined)).toBe(DEFAULT_LP_VAULT_ACCOUNTING_POLL_INTERVAL_MS);
    expect(lpVaultAccountingPollIntervalMs("1000")).toBe(1_000);
    expect(lpVaultAccountingPollIntervalMs("3600000")).toBe(3_600_000);
    for (const invalid of ["0", "999", "3600001", "1.5", "-1", "nope"]) {
      expect(() => lpVaultAccountingPollIntervalMs(invalid)).toThrow("invalid_lp_vault_accounting_poll_interval");
    }
  });

  it("propagates repository failures so the runtime records an unhealthy cycle", async () => {
    const runCycle = vi.fn().mockRejectedValue(new Error("lp_vault_reconciliation_stale"));
    await expect(processDueLpVaultAccountingCycle({ runCycle })).rejects.toThrow("lp_vault_reconciliation_stale");
  });
});

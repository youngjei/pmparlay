import { getAddress, isAddress, zeroAddress } from "viem";
import { getPool } from "./client";

function normalizeAddress(value: string) {
  if (!isAddress(value)) {
    throw new Error("invalid_evm_address");
  }

  const address = getAddress(value);
  if (address === zeroAddress) {
    throw new Error("invalid_evm_address");
  }

  return address;
}

export type TreasuryConfigInput = {
  chainId: number;
  currency: "USDC";
  treasuryAddress: string;
  usdcContractAddress: string;
  requiredConfirmations: number;
};

export type TreasuryConfigChangeInput = TreasuryConfigInput & {
  requestedBy: string;
  reason: string;
};

export async function proposeTreasuryConfigChange(input: TreasuryConfigChangeInput) {
  const treasuryAddress = normalizeAddress(input.treasuryAddress);
  const usdcContractAddress = normalizeAddress(input.usdcContractAddress);
  const result = await getPool().query<{ id: string; status: "pending" }>(
    `
      INSERT INTO treasury_config_changes (
        chain_id,
        currency,
        treasury_address,
        usdc_contract_address,
        required_confirmations,
        status,
        requested_by,
        reason
      )
      VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
      RETURNING id, status
    `,
    [input.chainId, input.currency, treasuryAddress, usdcContractAddress, input.requiredConfirmations, input.requestedBy, input.reason]
  );

  return result.rows[0];
}

export async function approveTreasuryConfigChange(input: { id: string; approvedBy: string; reason?: string }) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const changeResult = await client.query<{
      id: string;
      chain_id: number;
      currency: "USDC";
      treasury_address: string;
      usdc_contract_address: string;
      required_confirmations: number;
      status: string;
      requested_by: string;
    }>(
      `
        SELECT
          id,
          chain_id,
          currency,
          treasury_address,
          usdc_contract_address,
          required_confirmations,
          status,
          requested_by
        FROM treasury_config_changes
        WHERE id = $1
        FOR UPDATE
      `,
      [input.id]
    );
    const change = changeResult.rows[0];
    if (!change) {
      throw new Error("treasury_change_not_found");
    }
    if (change.status !== "pending") {
      throw new Error("treasury_change_not_pending");
    }
    if (change.requested_by === input.approvedBy) {
      throw new Error("treasury_change_second_approval_required");
    }

    await client.query(
      `
        UPDATE treasury_config
        SET active = false, updated_at = now()
        WHERE chain_id = $1
          AND currency = $2
          AND active = true
      `,
      [change.chain_id, change.currency]
    );
    const result = await client.query<{ id: string }>(
      `
        INSERT INTO treasury_config (
          chain_id,
          currency,
          treasury_address,
          usdc_contract_address,
          required_confirmations,
          active
        )
        VALUES ($1, $2, $3, $4, $5, true)
        RETURNING id
      `,
      [change.chain_id, change.currency, change.treasury_address, change.usdc_contract_address, change.required_confirmations]
    );
    await client.query(
      `
        UPDATE treasury_config_changes
        SET
          status = 'applied',
          approved_by = $2,
          approved_at = now(),
          applied_at = now()
        WHERE id = $1
      `,
      [change.id, input.approvedBy]
    );
    await client.query(
      `
        INSERT INTO audit_log (action, entity_type, entity_id, metadata)
        VALUES ($1, $2, $3, $4)
      `,
      [
        "treasury.config.applied",
        "treasury_config",
        result.rows[0].id,
        {
          changeId: change.id,
          requestedBy: change.requested_by,
          approvedBy: input.approvedBy,
          reason: input.reason || null
        }
      ]
    );
    await client.query("COMMIT");
    return {
      id: change.id,
      status: "applied" as const,
      configId: result.rows[0].id
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertActiveTreasuryConfig(input: TreasuryConfigInput) {
  const proposal = await proposeTreasuryConfigChange({
    ...input,
    requestedBy: "system",
    reason: "Legacy direct activation path"
  });
  const applied = await approveTreasuryConfigChange({
    id: proposal.id,
    approvedBy: "system-approval"
  });
  return applied.configId;
}

export async function getActiveTreasuryConfig(chainId: number, currency: "USDC") {
  const result = await getPool().query<{
    id: string;
    chainId: number;
    treasuryAddress: string;
    usdcContractAddress: string;
    requiredConfirmations: number;
    updatedAt: Date;
  }>(
    `
      SELECT
        id,
        chain_id AS "chainId",
        treasury_address AS "treasuryAddress",
        usdc_contract_address AS "usdcContractAddress",
        required_confirmations AS "requiredConfirmations",
        updated_at AS "updatedAt"
      FROM treasury_config
      WHERE chain_id = $1
        AND currency = $2
        AND active = true
      LIMIT 1
    `,
    [chainId, currency]
  );
  const row = result.rows[0];
  if (!row) return undefined;

  return {
    ...row,
    currency,
    updatedAt: row.updatedAt.toISOString()
  };
}

import { getPool } from "./client";

export async function ensureUserByEmail(email: string, displayName = "LEGWORK Beta User") {
  const result = await getPool().query<{ id: string }>(
    `
      INSERT INTO users (email, display_name)
      VALUES ($1, $2)
      ON CONFLICT (email)
      DO UPDATE SET updated_at = now()
      RETURNING id
    `,
    [email, displayName]
  );

  return result.rows[0].id;
}

export async function ensureUserByPrivyId(privyUserId: string) {
  const result = await getPool().query<{ id: string }>(
    `
      INSERT INTO users (privy_user_id, display_name)
      VALUES ($1, $2)
      ON CONFLICT (privy_user_id)
      DO UPDATE SET updated_at = now()
      RETURNING id
    `,
    [privyUserId, "LEGWORK User"]
  );

  return result.rows[0].id;
}

export async function getUserIdByPrivyId(privyUserId: string) {
  const result = await getPool().query<{ id: string }>(
    `
      SELECT id
      FROM users
      WHERE privy_user_id = $1
      LIMIT 1
    `,
    [privyUserId]
  );

  return result.rows[0]?.id;
}

export async function upsertUserWallet(input: { userId: string; address: string; chainId: number; source?: string }) {
  const address = input.address.toLowerCase();
  const result = await getPool().query<{ id: string; user_id: string }>(
    `
      INSERT INTO user_wallets (user_id, address, chain_id, source)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (address)
      DO UPDATE SET
        user_id = CASE WHEN user_wallets.user_id = EXCLUDED.user_id THEN EXCLUDED.user_id ELSE user_wallets.user_id END,
        chain_id = CASE WHEN user_wallets.user_id = EXCLUDED.user_id THEN EXCLUDED.chain_id ELSE user_wallets.chain_id END,
        source = CASE WHEN user_wallets.user_id = EXCLUDED.user_id THEN EXCLUDED.source ELSE user_wallets.source END,
        active = CASE WHEN user_wallets.user_id = EXCLUDED.user_id THEN true ELSE user_wallets.active END,
        verified_at = CASE WHEN user_wallets.user_id = EXCLUDED.user_id THEN now() ELSE user_wallets.verified_at END,
        updated_at = CASE WHEN user_wallets.user_id = EXCLUDED.user_id THEN now() ELSE user_wallets.updated_at END
      RETURNING id, user_id
    `,
    [input.userId, address, input.chainId, input.source || "privy"]
  );

  const row = result.rows[0];
  if (!row) throw new Error("wallet_upsert_failed");
  if (row.user_id !== input.userId) {
    throw new Error("wallet_already_linked");
  }

  return row.id;
}

export async function syncPrivyUserWallets(
  privyUserId: string,
  wallets: Array<{ address: string; chainId: number; source?: string }>
) {
  const client = await getPool().connect();
  const normalizedWallets = wallets.map((wallet) => ({
    ...wallet,
    address: wallet.address.toLowerCase(),
    source: wallet.source || "privy"
  }));

  try {
    await client.query("BEGIN");
    const userResult = await client.query<{ id: string }>(
      `
        INSERT INTO users (privy_user_id, display_name)
        VALUES ($1, $2)
        ON CONFLICT (privy_user_id)
        DO UPDATE SET updated_at = now()
        RETURNING id
      `,
      [privyUserId, "LEGWORK User"]
    );
    let userId = userResult.rows[0].id;

    if (normalizedWallets.length > 0) {
      const addresses = normalizedWallets.map((wallet) => wallet.address);
      const conflictResult = await client.query<{ user_id: string }>(
        `
          SELECT user_id
          FROM user_wallets
          WHERE address = ANY($1::text[])
            AND user_id <> $2
          FOR UPDATE
        `,
        [addresses, userId]
      );

      if (conflictResult.rows.length > 0) {
        const conflictUserIds = [...new Set(conflictResult.rows.map((row) => row.user_id))];
        if (conflictUserIds.length > 1) {
          throw new Error("wallet_already_linked");
        }

        const walletUserId = conflictUserIds[0];
        const activityResult = await client.query<{ activity_count: string }>(
          `
            SELECT (
              (SELECT count(*) FROM tickets WHERE user_id = $1) +
              (SELECT count(*) FROM ledger_accounts WHERE user_id = $1)
            )::text AS activity_count
          `,
          [userId]
        );
        if (Number(activityResult.rows[0]?.activity_count || 0) > 0) {
          throw new Error("wallet_already_linked");
        }

        await client.query(
          `
            UPDATE users
            SET privy_user_id = NULL, updated_at = now()
            WHERE id = $1
              AND privy_user_id = $2
          `,
          [userId, privyUserId]
        );
        await client.query(
          `
            UPDATE users
            SET privy_user_id = $2, updated_at = now()
            WHERE id = $1
          `,
          [walletUserId, privyUserId]
        );
        userId = walletUserId;
      }

      for (const wallet of normalizedWallets) {
        await client.query(
          `
            INSERT INTO user_wallets (user_id, address, chain_id, source, active)
            VALUES ($1, $2, $3, $4, true)
            ON CONFLICT (address)
            DO UPDATE SET
              chain_id = EXCLUDED.chain_id,
              source = EXCLUDED.source,
              active = true,
              verified_at = now(),
              updated_at = now()
            WHERE user_wallets.user_id = EXCLUDED.user_id
          `,
          [userId, wallet.address, wallet.chainId, wallet.source]
        );
      }
    }

    await client.query(
      `
        UPDATE user_wallets
        SET active = false, updated_at = now()
        WHERE user_id = $1
          AND source = 'privy'
          AND NOT (address = ANY($2::text[]))
      `,
      [userId, normalizedWallets.map((wallet) => wallet.address)]
    );

    await client.query("COMMIT");
    return {
      userId,
      wallets: normalizedWallets.map((wallet) => ({
        address: wallet.address,
        chainId: wallet.chainId
      }))
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listUserWallets(userId: string) {
  const result = await getPool().query<{
    id: string;
    address: string;
    chainId: number;
    source: string;
    verifiedAt: Date;
  }>(
    `
      SELECT
        id,
        address,
        chain_id AS "chainId",
        source,
        verified_at AS "verifiedAt"
      FROM user_wallets
      WHERE user_id = $1
        AND active = true
      ORDER BY verified_at DESC
    `,
    [userId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    address: row.address,
    chainId: row.chainId,
    source: row.source,
    verifiedAt: row.verifiedAt.toISOString()
  }));
}

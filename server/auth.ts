import { timingSafeEqual } from "node:crypto";
import { verifyAccessToken, verifyIdentityToken } from "@privy-io/node";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet } from "jose";
import { isAddress } from "viem";
import { config } from "./config";
import { ensureUserByEmail, ensureUserByPrivyId, getUserIdByPrivyId, syncPrivyUserWallets } from "./db/userRepository";

export function constantTimeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function bearerToken(request: FastifyRequest) {
  const value = request.headers.authorization;
  const header = Array.isArray(value) ? value[0] : value;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim();
}

let privyJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getPrivyJwks() {
  if (!config.PRIVY_JWKS_URL) return undefined;
  privyJwks ||= createRemoteJWKSet(new URL(config.PRIVY_JWKS_URL));
  return privyJwks;
}

type PrivyEvmWalletAccount = {
  type: "wallet" | "smart_wallet";
  chain_type?: string;
  address: string;
  chain_id?: string | number;
};

export function parsePrivyChainId(chainId: unknown) {
  if (typeof chainId === "number") {
    return Number.isInteger(chainId) && chainId > 0 ? chainId : undefined;
  }

  if (typeof chainId !== "string" || chainId.trim() === "") {
    return undefined;
  }

  const rawValue = chainId.includes(":") ? chainId.split(":").at(-1) : chainId;
  const parsed = rawValue ? Number(rawValue) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isPrivyEvmWallet(account: unknown): account is PrivyEvmWalletAccount {
  if (!account || typeof account !== "object") return false;
  const item = account as Record<string, unknown>;
  if (typeof item.address !== "string" || !isAddress(item.address, { strict: false })) return false;
  if (item.type === "smart_wallet") return true;
  if (item.type !== "wallet") return false;

  // Privy linked-account payloads are not perfectly uniform across wallet clients.
  // A valid EVM address is the hard requirement; chain_type narrows only when present.
  return item.chain_type === undefined || item.chain_type === "ethereum";
}

export function privyWalletsFromLinkedAccounts(linkedAccounts: unknown[]) {
  const wallets = [];

  for (const account of linkedAccounts) {
    if (!isPrivyEvmWallet(account)) continue;
    wallets.push({
      address: account.address.toLowerCase(),
      chainId: config.SETTLEMENT_CHAIN_ID,
      source: "privy"
    });
  }

  return wallets;
}

export async function userIdFromPrivyAccessToken(accessToken: string) {
  if (!config.PRIVY_APP_ID) {
    throw new Error("privy_not_configured");
  }

  const jwks = getPrivyJwks();
  if (!jwks) {
    throw new Error("privy_not_configured");
  }

  const verified = await verifyAccessToken({
    access_token: accessToken,
    app_id: config.PRIVY_APP_ID,
    verification_key: jwks
  });

  return ensureUserByPrivyId(verified.user_id);
}

export async function syncPrivyIdentityToken(identityToken: string, expectedUserId?: string) {
  if (!config.PRIVY_APP_ID) {
    throw new Error("privy_not_configured");
  }

  const jwks = getPrivyJwks();
  if (!jwks) {
    throw new Error("privy_not_configured");
  }

  const privyUser = await verifyIdentityToken({
    identity_token: identityToken,
    app_id: config.PRIVY_APP_ID,
    verification_key: jwks
  });

  if (expectedUserId) {
    const identityUserId = await getUserIdByPrivyId(privyUser.id);
    if (identityUserId !== expectedUserId) {
      throw new Error("identity_token_user_mismatch");
    }
  }

  const wallets = privyWalletsFromLinkedAccounts(privyUser.linked_accounts || []);
  const synced = await syncPrivyUserWallets(privyUser.id, wallets);

  return {
    userId: synced.userId,
    privyUserId: privyUser.id,
    wallets: synced.wallets
  };
}

export async function requireUserId(request: FastifyRequest, reply: FastifyReply) {
  if (config.NODE_ENV === "test") {
    return "00000000-0000-0000-0000-000000000001";
  }

  const token = bearerToken(request);
  if (token && config.ACCOUNTING_MODE !== "house_book_usdc" && config.BETA_USER_API_KEY && constantTimeEqual(token, config.BETA_USER_API_KEY)) {
    return ensureUserByEmail(config.BETA_USER_EMAIL);
  }

  if (token && config.PRIVY_APP_ID) {
    try {
      return await userIdFromPrivyAccessToken(token);
    } catch {
      reply.status(401).send({
        error: "unauthorized"
      });
      return undefined;
    }
  }

  if (config.ACCOUNTING_MODE === "house_book_usdc") {
    reply.status(401).send({
      error: "unauthorized"
    });
    return undefined;
  }

  if (config.BETA_USER_API_KEY) {
    if (!token || !constantTimeEqual(token, config.BETA_USER_API_KEY)) {
      reply.status(401).send({
        error: "unauthorized"
      });
      return undefined;
    }
  }

  return ensureUserByEmail(config.BETA_USER_EMAIL);
}

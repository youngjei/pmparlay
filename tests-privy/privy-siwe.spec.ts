import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { parse } from "dotenv";
import { getAddress, hexToString, isHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

function loadBurnerAccount() {
  const filename = path.resolve(".context/sepolia-burner.env");
  if ((statSync(filename).mode & 0o077) !== 0) throw new Error("burner_wallet_file_permissions_invalid");
  const values = parse(readFileSync(filename));
  const privateKey = values.SEPOLIA_BURNER_PRIVATE_KEY;
  const expectedAddress = values.SEPOLIA_BURNER_ADDRESS;
  if (!privateKey || !expectedAddress || !/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error("burner_wallet_configuration_invalid");
  }
  const account = privateKeyToAccount(privateKey as Hex);
  if (account.address !== getAddress(expectedAddress)) throw new Error("burner_wallet_address_mismatch");
  return account;
}

function assertExpectedSiweMessage(message: string, address: Address) {
  if (message.length > 4_096) throw new Error("siwe_message_too_large");
  const expectedPrefix = `localhost:5175 wants you to sign in with your Ethereum account:\n${address}`;
  if (!message.startsWith(expectedPrefix)) throw new Error("siwe_domain_or_address_mismatch");
  if (!message.includes("\nURI: http://localhost:5175\n")) throw new Error("siwe_uri_mismatch");
  if (!message.includes("\nVersion: 1\n")) throw new Error("siwe_version_mismatch");
  if (!message.includes("\nChain ID: 11155111\n")) throw new Error("siwe_chain_mismatch");
  if (!/\nNonce: [a-zA-Z0-9]{8,}\n/.test(message)) throw new Error("siwe_nonce_invalid");
  const issuedAt = message.match(/\nIssued At: ([^\n]+)(?:\n|$)/)?.[1];
  const issuedAtMs = issuedAt ? Date.parse(issuedAt) : NaN;
  if (!Number.isFinite(issuedAtMs) || Math.abs(Date.now() - issuedAtMs) > 5 * 60_000) {
    throw new Error("siwe_issued_at_invalid");
  }
}

test("real Privy SIWE links the burner through production token verification", async ({ page }) => {
  const account = loadBurnerAccount();
  const address = account.address;
  let signedSiwe = false;

  await page.exposeBinding("__legworkQaWalletRpc", async (source, input: { method: string; params?: unknown[] }) => {
    if (source.frame !== page.mainFrame() || new URL(source.frame.url()).origin !== "http://localhost:5175") {
      throw new Error("test_wallet_untrusted_frame");
    }
    const params = input.params || [];
    switch (input.method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return [address];
      case "eth_chainId":
        return "0xaa36a7";
      case "net_version":
        return "11155111";
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain":
        return null;
      case "personal_sign": {
        if (signedSiwe) throw new Error("test_wallet_signature_already_used");
        const message = params.find((value) => typeof value === "string" && value.toLowerCase() !== address.toLowerCase());
        if (typeof message !== "string") throw new Error("personal_sign_message_missing");
        assertExpectedSiweMessage(isHex(message) ? hexToString(message) : message, address);
        signedSiwe = true;
        return await account.signMessage({ message: isHex(message) ? { raw: message as Hex } : message });
      }
      default:
        throw new Error(`unsupported_test_wallet_method:${input.method}`);
    }
  });

  await page.addInitScript(({ walletAddress }) => {
    if (window.top !== window) return;
    type RequestInput = { method: string; params?: unknown[] };
    type ProviderListener = (...args: unknown[]) => void;
    const listeners = new Map<string, Set<ProviderListener>>();
    const provider = {
      isLegworkQaWallet: true,
      isConnected: () => true,
      request: (input: RequestInput) =>
        (window as typeof window & { __legworkQaWalletRpc: (value: RequestInput) => Promise<unknown> }).__legworkQaWalletRpc(
          input
        ),
      on(event: string, listener: ProviderListener) {
        const current = listeners.get(event) || new Set<ProviderListener>();
        current.add(listener);
        listeners.set(event, current);
        return provider;
      },
      removeListener(event: string, listener: ProviderListener) {
        listeners.get(event)?.delete(listener);
        return provider;
      },
      selectedAddress: walletAddress,
      chainId: "0xaa36a7"
    };
    const detail = Object.freeze({
      info: {
        uuid: "5e7a9a8c-79e1-4c2d-89ad-5a5c3f15aabc",
        name: "LEGWORK QA Wallet",
        icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        rdns: "io.legwork.qa"
      },
      provider
    });
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
    window.addEventListener("eip6963:requestProvider", announce);
    Object.defineProperty(window, "ethereum", { configurable: false, value: provider });
    announce();
  }, { walletAddress: address });

  await page.goto("/");
  const accountResponsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/account") && response.request().method() === "GET",
    { timeout: 30_000 }
  );
  const syncResponsePromise = page
    .waitForResponse(
      (response) => response.url().endsWith("/api/auth/privy/sync") && response.request().method() === "POST",
      { timeout: 15_000 }
    )
    .catch(() => undefined);
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByText("LEGWORK QA Wallet", { exact: true }).click();

  expect((await accountResponsePromise).status()).toBe(200);
  const syncResponse = await syncResponsePromise;
  if (!syncResponse) {
    throw new Error(
      "privy_identity_token_unavailable: enable User management > Authentication > Advanced > Return user data in an identity token"
    );
  }
  expect(syncResponse.status()).toBe(200);
  const body = (await syncResponse.json()) as { wallets: Array<{ address: Address }> };
  expect(body.wallets.map((wallet) => getAddress(wallet.address))).toContain(address);
});

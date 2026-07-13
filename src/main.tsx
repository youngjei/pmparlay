import { StrictMode, useEffect, useRef, useState } from "react";
import { PrivyProvider, useIdentityToken, usePrivy, useWallets } from "@privy-io/react-auth";
import { createRoot } from "react-dom/client";
import { createPublicClient, createWalletClient, custom, erc20Abi, formatUnits, http } from "viem";
import { mainnet, sepolia } from "viem/chains";
import App from "./App";
import "./styles.css";

const privyAppId = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;
const walletConnectCloudProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;
const privyEnabled = import.meta.env.VITE_ENABLE_PRIVY === "true";
const configuredSettlementChainId = Number(import.meta.env.VITE_SETTLEMENT_CHAIN_ID || sepolia.id);
const configuredUsdcContractAddress =
  (import.meta.env.VITE_USDC_CONTRACT_ADDRESS as string | undefined) || "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

type WalletSyncStatus = "idle" | "syncing" | "synced" | "limited" | "error";
type WalletBalanceState = "idle" | "loading" | "ready" | "error";

function supportedSettlementChain(chainId: number) {
  if (chainId === mainnet.id) return mainnet;
  if (chainId === sepolia.id) return sepolia;
  return undefined;
}

function LegworkApp() {
  const privy = usePrivy();
  const { identityToken } = useIdentityToken();
  const { wallets } = useWallets();
  const syncedIdentityToken = useRef<string | null>(null);
  const [walletSynced, setWalletSynced] = useState(false);
  const [walletSyncStatus, setWalletSyncStatus] = useState<WalletSyncStatus>("idle");
  const [walletSyncError, setWalletSyncError] = useState("");
  const [walletSyncRetryKey, setWalletSyncRetryKey] = useState(0);
  const [walletBalanceState, setWalletBalanceState] = useState<WalletBalanceState>("idle");
  const [walletUsdcBalance, setWalletUsdcBalance] = useState<number | null>(null);
  const [walletBalanceError, setWalletBalanceError] = useState("");
  const walletLabel = wallets[0]?.address ? `${wallets[0].address.slice(0, 6)}...${wallets[0].address.slice(-4)}` : "Wallet connected";

  async function sendUsdcPayment(input: { treasuryAddress: string; usdcContractAddress: string; amountMicroUnits: string; chainId: number }) {
    const wallet = wallets[0];
    if (!wallet) throw new Error("No connected wallet found.");
    const chain = supportedSettlementChain(input.chainId);
    if (!chain) {
      throw new Error("LEGWORK currently supports USDC purchases on Ethereum mainnet and Sepolia.");
    }
    if (wallet.chainId !== `eip155:${input.chainId}`) {
      await wallet.switchChain(input.chainId);
    }
    const provider = await wallet.getEthereumProvider();
    const client = createWalletClient({
      account: wallet.address as `0x${string}`,
      chain,
      transport: custom(provider)
    });
    return await client.writeContract({
      address: input.usdcContractAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: "transfer",
      args: [input.treasuryAddress as `0x${string}`, BigInt(input.amountMicroUnits)]
    });
  }

  useEffect(() => {
    const wallet = wallets[0];
    const chain = supportedSettlementChain(configuredSettlementChainId);
    if (!privy.authenticated || !wallet || !chain) {
      setWalletUsdcBalance(null);
      setWalletBalanceState("idle");
      setWalletBalanceError("");
      return;
    }

    let isMounted = true;
    setWalletBalanceState("loading");
    setWalletBalanceError("");

    const client = createPublicClient({
      chain,
      transport: http()
    });

    client
      .readContract({
        address: configuredUsdcContractAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet.address as `0x${string}`]
      })
      .then((balance) => {
        if (!isMounted) return;
        setWalletUsdcBalance(Number(formatUnits(balance, 6)));
        setWalletBalanceState("ready");
      })
      .catch((error: unknown) => {
        if (!isMounted) return;
        setWalletUsdcBalance(null);
        setWalletBalanceState("error");
        setWalletBalanceError(error instanceof Error ? error.message : "USDC balance unavailable.");
      });

    return () => {
      isMounted = false;
    };
  }, [privy.authenticated, wallets[0]?.address]);

  useEffect(() => {
    if (!privy.authenticated) {
      syncedIdentityToken.current = null;
      setWalletSynced(false);
      setWalletSyncStatus("idle");
      setWalletSyncError("");
      return;
    }
    if (!privy.ready) {
      setWalletSynced(false);
      setWalletSyncStatus("syncing");
      setWalletSyncError("");
      return;
    }
    if (!identityToken) {
      syncedIdentityToken.current = null;
      setWalletSynced(false);
      setWalletSyncStatus("syncing");
      setWalletSyncError("");

      const timeout = window.setTimeout(() => {
        setWalletSyncStatus("limited");
        setWalletSyncError("Your account is connected. LEGWORK is still waiting for wallet details from Privy, so wallet-specific actions may take a moment to appear.");
      }, 8_000);

      return () => window.clearTimeout(timeout);
    }
    if (syncedIdentityToken.current === identityToken) {
      setWalletSynced(true);
      setWalletSyncStatus("synced");
      setWalletSyncError("");
      return;
    }

    const controller = new AbortController();
    syncedIdentityToken.current = identityToken;
    setWalletSynced(false);
    setWalletSyncStatus("syncing");
    setWalletSyncError("");

    void (async () => {
      const accessToken = await privy.getAccessToken();
      if (controller.signal.aborted) return;
      if (!accessToken) {
        syncedIdentityToken.current = null;
        setWalletSynced(false);
        setWalletSyncStatus("error");
        setWalletSyncError("LEGWORK could not verify this session. Reconnect your wallet to continue.");
        return;
      }

      const response = await fetch("/api/auth/privy/sync", {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ identityToken }),
        signal: controller.signal
      });

      if (!response.ok) {
        syncedIdentityToken.current = null;
        setWalletSynced(false);
        setWalletSyncStatus("limited");
        setWalletSyncError("Your account is connected, but LEGWORK could not refresh wallet details yet. Portfolio data can still load.");
        return;
      }

      setWalletSynced(true);
      setWalletSyncStatus("synced");
      setWalletSyncError("");
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) {
        syncedIdentityToken.current = null;
        setWalletSynced(false);
        setWalletSyncStatus("limited");
        setWalletSyncError(error instanceof Error ? error.message : "Your account is connected, but wallet details are still syncing.");
      }
    });

    return () => controller.abort();
  }, [identityToken, privy.authenticated, privy.ready, walletSyncRetryKey]);

  return (
    <App
      auth={{
        enabled: true,
        authenticated: privy.authenticated,
        ready: privy.ready,
        walletSynced,
        walletSyncStatus,
        walletSyncError,
        walletUsdcBalance,
        walletBalanceState,
        walletBalanceError,
        userLabel: walletLabel,
        getAccessToken: privy.getAccessToken,
        sendUsdcPayment,
        login: privy.login,
        retryWalletSync: () => setWalletSyncRetryKey((key) => key + 1),
        logout: () => {
          void privy.logout();
        }
      }}
    />
  );
}

const app = privyEnabled && privyAppId ? (
  <PrivyProvider
    appId={privyAppId}
    config={{
      loginMethods: ["wallet"],
      appearance: {
        theme: "light",
        accentColor: "#86ef00",
        logo: undefined
      },
      embeddedWallets: {
        ethereum: {
          createOnLogin: "off"
        }
      },
      walletConnectCloudProjectId
    }}
  >
    <LegworkApp />
  </PrivyProvider>
) : (
  <App />
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {app}
  </StrictMode>
);

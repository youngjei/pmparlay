import { useCallback, useEffect, useRef, useState } from "react";
import { PrivyProvider, useIdentityToken, usePrivy, useWallets } from "@privy-io/react-auth";
import { createPublicClient, createWalletClient, custom, erc20Abi, formatUnits, http } from "viem";
import { sepolia } from "viem/chains";
import { canCommitWalletSyncAttempt } from "./walletSync";

const circleSepoliaUsdcContractAddress = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

type WalletSyncStatus = "idle" | "syncing" | "synced" | "limited" | "error";
type WalletBalanceState = "idle" | "loading" | "ready" | "error";

export type WalletRuntimeAuth = {
  authenticated: boolean;
  ready: boolean;
  walletSynced: boolean;
  walletSyncStatus: WalletSyncStatus;
  walletSyncError: string;
  walletUsdcBalance: number | null;
  walletBalanceState: WalletBalanceState;
  walletBalanceError: string;
  userLabel: string;
  walletAddress?: string;
  getAccessToken: () => Promise<string | null>;
  sendUsdcPayment: (input: {
    treasuryAddress: string;
    usdcContractAddress: string;
    amountMicroUnits: string;
    chainId: number;
  }) => Promise<`0x${string}` | string>;
  retryWalletSync: () => void;
  logout: () => void;
};

type WalletRuntimeProps = {
  appId: string;
  walletConnectCloudProjectId?: string;
  configuredUsdcContractAddress: string;
  connectIntent: number;
  onAuthChange: (auth: WalletRuntimeAuth) => void;
};

function WalletSession({ configuredUsdcContractAddress, connectIntent, onAuthChange }: Omit<WalletRuntimeProps, "appId" | "walletConnectCloudProjectId">) {
  const privy = usePrivy();
  const { identityToken } = useIdentityToken();
  const { wallets } = useWallets();
  const syncedIdentityToken = useRef<string | null>(null);
  const walletSyncGeneration = useRef(0);
  const handledConnectIntent = useRef(0);
  const [walletSynced, setWalletSynced] = useState(false);
  const [walletSyncStatus, setWalletSyncStatus] = useState<WalletSyncStatus>("idle");
  const [walletSyncError, setWalletSyncError] = useState("");
  const [walletSyncRetryKey, setWalletSyncRetryKey] = useState(0);
  const [walletBalanceState, setWalletBalanceState] = useState<WalletBalanceState>("idle");
  const [walletUsdcBalance, setWalletUsdcBalance] = useState<number | null>(null);
  const [walletBalanceError, setWalletBalanceError] = useState("");
  const wallet = wallets[0];
  const walletAddress = wallet?.address;
  const walletLabel = walletAddress ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}` : "Wallet connected";

  useEffect(() => {
    if (!privy.ready || connectIntent <= handledConnectIntent.current) return;
    handledConnectIntent.current = connectIntent;
    void privy.login();
  }, [connectIntent, privy]);

  const sendUsdcPayment = useCallback(
    async (input: { treasuryAddress: string; usdcContractAddress: string; amountMicroUnits: string; chainId: number }) => {
      if (!wallet) throw new Error("No connected wallet found.");
      if (
        input.chainId !== sepolia.id ||
        input.usdcContractAddress.toLowerCase() !== circleSepoliaUsdcContractAddress.toLowerCase()
      ) {
        throw new Error("This staging build supports payments only with Sepolia and Circle Sepolia USDC.");
      }
      if (wallet.chainId !== `eip155:${input.chainId}`) {
        await wallet.switchChain(input.chainId);
      }
      const provider = await wallet.getEthereumProvider();
      const client = createWalletClient({
        account: wallet.address as `0x${string}`,
        chain: sepolia,
        transport: custom(provider)
      });
      return await client.writeContract({
        address: circleSepoliaUsdcContractAddress,
        abi: erc20Abi,
        functionName: "transfer",
        args: [input.treasuryAddress as `0x${string}`, BigInt(input.amountMicroUnits)]
      });
    },
    [wallet]
  );

  useEffect(() => {
    if (!privy.authenticated || !wallet) {
      setWalletUsdcBalance(null);
      setWalletBalanceState("idle");
      setWalletBalanceError("");
      return;
    }

    let isMounted = true;
    setWalletBalanceState("loading");
    setWalletBalanceError("");

    const client = createPublicClient({
      chain: sepolia,
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
  }, [configuredUsdcContractAddress, privy.authenticated, walletAddress]);

  useEffect(() => {
    const generation = ++walletSyncGeneration.current;
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
    const isCurrent = () => canCommitWalletSyncAttempt(walletSyncGeneration.current, generation, controller.signal.aborted);
    setWalletSynced(false);
    setWalletSyncStatus("syncing");
    setWalletSyncError("");

    void (async () => {
      const accessToken = await privy.getAccessToken();
      if (!isCurrent()) return;
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

      if (!isCurrent()) return;

      if (!response.ok) {
        syncedIdentityToken.current = null;
        setWalletSynced(false);
        setWalletSyncStatus("limited");
        setWalletSyncError("Your account is connected, but LEGWORK could not refresh wallet details yet. Portfolio data can still load.");
        return;
      }

      syncedIdentityToken.current = identityToken;
      setWalletSynced(true);
      setWalletSyncStatus("synced");
      setWalletSyncError("");
    })().catch((error: unknown) => {
      if (isCurrent()) {
        syncedIdentityToken.current = null;
        setWalletSynced(false);
        setWalletSyncStatus("limited");
        setWalletSyncError(error instanceof Error ? error.message : "Your account is connected, but wallet details are still syncing.");
      }
    });

    return () => controller.abort();
  }, [identityToken, privy.authenticated, privy.ready, walletSyncRetryKey]);

  useEffect(() => {
    onAuthChange({
      authenticated: privy.authenticated,
      ready: privy.ready,
      walletSynced,
      walletSyncStatus,
      walletSyncError,
      walletUsdcBalance,
      walletBalanceState,
      walletBalanceError,
      userLabel: walletLabel,
      walletAddress,
      getAccessToken: privy.getAccessToken,
      sendUsdcPayment,
      retryWalletSync: () => setWalletSyncRetryKey((key) => key + 1),
      logout: () => {
        void privy.logout();
      }
    });
  }, [
    onAuthChange,
    privy.authenticated,
    privy.ready,
    sendUsdcPayment,
    walletAddress,
    walletBalanceError,
    walletBalanceState,
    walletLabel,
    walletSynced,
    walletSyncError,
    walletSyncStatus,
    walletUsdcBalance
  ]);

  return null;
}

export default function WalletRuntime({ appId, walletConnectCloudProjectId, ...sessionProps }: WalletRuntimeProps) {
  return (
    <PrivyProvider
      appId={appId}
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
      <WalletSession {...sessionProps} />
    </PrivyProvider>
  );
}

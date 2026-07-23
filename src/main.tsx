import { lazy, StrictMode, Suspense, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import type { WalletRuntimeAuth } from "./WalletRuntime";
import "./styles.css";

const circleSepoliaUsdcContractAddress = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const sepoliaChainId = 11155111;
const privyAppId = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;
const walletConnectCloudProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;
const privyEnabled = import.meta.env.VITE_ENABLE_PRIVY === "true";
const configuredSettlementChainId = Number(import.meta.env.VITE_SETTLEMENT_CHAIN_ID || sepoliaChainId);
const configuredUsdcContractAddress =
  (import.meta.env.VITE_USDC_CONTRACT_ADDRESS as string | undefined) || circleSepoliaUsdcContractAddress;

const walletPaymentConfigSupported =
  configuredSettlementChainId === sepoliaChainId &&
  configuredUsdcContractAddress.toLowerCase() === circleSepoliaUsdcContractAddress.toLowerCase();
const walletSessionHintKey = "legwork.wallet-session";

const WalletRuntime = lazy(() => import("./WalletRuntime"));

const initialWalletAuth: WalletRuntimeAuth = {
  authenticated: false,
  ready: false,
  walletSynced: false,
  walletSyncStatus: "idle",
  walletSyncError: "",
  walletUsdcBalance: null,
  walletBalanceState: "idle",
  walletBalanceError: "",
  userLabel: "Wallet connected",
  getAccessToken: async () => null,
  sendUsdcPayment: async () => {
    throw new Error("Connected wallet payment is unavailable. Reconnect your wallet and try again.");
  },
  retryWalletSync: () => {},
  logout: () => {}
};

function WalletEnabledApp() {
  const [connectIntent, setConnectIntent] = useState(0);
  const [runtimeRequested, setRuntimeRequested] = useState(
    () => window.localStorage.getItem(walletSessionHintKey) === "1"
  );
  const [runtimeReported, setRuntimeReported] = useState(false);
  const [walletAuth, setWalletAuth] = useState<WalletRuntimeAuth>(initialWalletAuth);
  const requestWalletConnection = useCallback(() => {
    setRuntimeRequested(true);
    setConnectIntent((intent) => intent + 1);
  }, []);
  const handleAuthChange = useCallback((nextAuth: WalletRuntimeAuth) => {
    if (nextAuth.authenticated) window.localStorage.setItem(walletSessionHintKey, "1");
    else if (nextAuth.ready) window.localStorage.removeItem(walletSessionHintKey);
    setWalletAuth(nextAuth);
    setRuntimeReported(true);
  }, []);

  const auth = useMemo(
    () => ({
      enabled: true,
      ...walletAuth,
      ready: connectIntent === 0 && !runtimeReported ? true : walletAuth.ready,
      login: requestWalletConnection
    }),
    [connectIntent, requestWalletConnection, runtimeReported, walletAuth]
  );

  return (
    <>
      <App auth={auth} />
      {runtimeRequested ? (
        <Suspense fallback={null}>
          <WalletRuntime
            appId={privyAppId!}
            walletConnectCloudProjectId={walletConnectCloudProjectId}
            configuredUsdcContractAddress={configuredUsdcContractAddress}
            connectIntent={connectIntent}
            onAuthChange={handleAuthChange}
          />
        </Suspense>
      ) : null}
    </>
  );
}

const app = privyEnabled && privyAppId && walletPaymentConfigSupported ? <WalletEnabledApp /> : <App />;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {app}
  </StrictMode>
);

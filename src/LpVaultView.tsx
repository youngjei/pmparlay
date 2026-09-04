import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Blocks,
  CheckCircle2,
  CircleAlert,
  Clock3,
  ExternalLink,
  Landmark,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Wallet
} from "lucide-react";
import {
  canShowLpVaultAmounts,
  collateralHealthCopy,
  explorerBaseUrl,
  explorerUrl,
  fetchLpVault,
  formatDateTime,
  formatRatio,
  formatReconciliationAge,
  formatUsd,
  gateCopy,
  getLpVaultDisplayState,
  liquidityWindowCopy,
  shortHash,
  unavailableCopy,
  type LpVaultFetcher,
  type LpVaultResponse
} from "./lpVault";
import "./lpVault.css";

export type LpVaultViewProps = {
  authenticated: boolean;
  onConnect?: () => void;
  endpoint?: string;
  fetcher?: LpVaultFetcher;
};

type ViewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; data: LpVaultResponse };

const emptyValue = "--";

function ExternalValue({ href, children }: { href?: string; children: React.ReactNode }) {
  if (!href) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children} <ExternalLink aria-hidden="true" size={13} />
    </a>
  );
}

function Gate({ label, value }: { label: string; value: "open" | "paused" | "restricted" | "blocked" | "not_live" }) {
  const copy = gateCopy(value);
  return (
    <div className={`lp-vault__gate lp-vault__gate--${copy.tone}`}>
      <span>{label}</span>
      <strong>{copy.label}</strong>
    </div>
  );
}

function LoadingView() {
  return (
    <section className="lp-vault" aria-busy="true" aria-live="polite" aria-label="LP Vault">
      <section className="lp-vault__hero lp-vault__loading">
        <div className="lp-vault__eyebrow"><RefreshCw size={14} /> Loading LP Vault</div>
        <div className="lp-vault__skeleton lp-vault__skeleton--title" />
        <div className="lp-vault__skeleton lp-vault__skeleton--copy" />
        <div className="lp-vault__loading-grid">
          <div className="lp-vault__skeleton" />
          <div className="lp-vault__skeleton" />
          <div className="lp-vault__skeleton" />
        </div>
      </section>
    </section>
  );
}

export function LpVaultView({ authenticated, onConnect, endpoint, fetcher }: LpVaultViewProps) {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [requestVersion, setRequestVersion] = useState(0);
  const [freshnessVersion, setFreshnessVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async (showLoading: boolean) => {
      if (showLoading) setView({ kind: "loading" });
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const data = await fetchLpVault(endpoint, fetcher, controller.signal);
        if (!cancelled) setView({ kind: "loaded", data });
      } catch (error: unknown) {
        if (!cancelled) {
          setView({ kind: "error", message: error instanceof Error ? error.message : "Unable to load vault availability." });
        }
      } finally {
        window.clearTimeout(timeout);
      }
    };
    void load(true);
    const refreshInterval = window.setInterval(() => void load(false), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(refreshInterval);
    };
  }, [endpoint, fetcher, requestVersion]);

  useEffect(() => {
    if (view.kind !== "loaded" || view.data.availability !== "available" || !view.data.snapshot) return;
    const staleAt = Date.parse(view.data.snapshot.asOf) + 5 * 60_000;
    const timeout = window.setTimeout(() => setFreshnessVersion((value) => value + 1), Math.max(0, staleAt - Date.now() + 1));
    return () => window.clearTimeout(timeout);
  }, [view]);

  void freshnessVersion;

  if (view.kind === "loading") return <LoadingView />;

  if (view.kind === "error") {
    return (
      <section className="lp-vault" aria-label="LP Vault">
        <section className="lp-vault__hero lp-vault__unavailable" aria-live="polite">
          <div className="lp-vault__eyebrow"><CircleAlert size={14} /> LP Vault shadow mode</div>
          <h1>Vault status is unavailable</h1>
          <p>{view.message} No capital amounts are shown without a verified reconciliation.</p>
          <div className="lp-vault__error-actions">
            <button className="lp-vault__connect" type="button" onClick={() => setRequestVersion((value) => value + 1)}><RefreshCw size={17} /> Retry</button>
            {!authenticated && onConnect ? <button className="lp-vault__secondary-action" type="button" onClick={onConnect}><Wallet size={17} /> Connect wallet</button> : null}
          </div>
        </section>
      </section>
    );
  }

  const { data } = view;
  const state = getLpVaultDisplayState(data);
  const hasAmounts = canShowLpVaultAmounts(data);
  const snapshot = hasAmounts && data.snapshot ? data.snapshot : null;
  const unavailable = state === "ready" ? null : unavailableCopy(state);
  const nextWindow = liquidityWindowCopy(data.epoch);
  const explorer = explorerBaseUrl(data.network.chainId);
  const tokenUrl = explorerUrl(explorer, `address/${data.vault?.tokenAddress ?? ""}`);
  const treasuryUrl = explorerUrl(explorer, `address/${data.vault?.treasuryAddress ?? ""}`);
  const blockUrl = snapshot ? explorerUrl(explorer, `block/${snapshot.blockNumber}`) : undefined;
  const snapshotUrl = snapshot ? endpoint ?? "/api/lp-vault" : undefined;
  const collateralHealth = snapshot ? collateralHealthCopy(snapshot) : null;
  const payoutCoverageDisplay = snapshot
    ? snapshot.grossUnresolvedPayoutsUsd === 0 ? "No live tickets" : formatRatio(snapshot.grossCoverage)
    : emptyValue;

  return (
    <section className="lp-vault" aria-label="LP Vault">
      <section className="lp-vault__hero">
        <div className="lp-vault__hero-head">
          <div>
            <div className="lp-vault__eyebrow"><ShieldCheck size={14} /> LP Vault <span>Founder-funded Sepolia shadow</span></div>
            <h1>House-book reserve monitor</h1>
            <p>Reconciled test-USDC observation of LEGWORK's global house book. No segregated LP assets, deposits, or withdrawals are live.</p>
          </div>
          <div className="lp-vault__network"><Blocks size={15} /> {data.network.name} <span>Chain {data.network.chainId}</span></div>
        </div>

        <div className="lp-vault__action-row">
          <div className="lp-vault__action-state">
            <LockKeyhole size={18} />
            <div><strong>{unavailable?.title ?? "Community LP activity is not live"}</strong><span>{unavailable?.detail ?? "This founder-funded shadow monitor observes reserves without accepting LP capital."}</span><span>Shadow epoch status: {nextWindow.detail} This is not a deposit or withdrawal window.</span></div>
          </div>
          {snapshot ? <button className="lp-vault__secondary-action" type="button" onClick={() => document.getElementById("capital-breakdown-title")?.scrollIntoView({ behavior: "smooth" })}><ShieldCheck size={17} /> View shadow reserves</button> : null}
        </div>
        <p className="lp-vault__commitment"><Clock3 size={15} /> Policy under evaluation: future LP results would be pro rata and funded payouts FIFO. No LP payouts are live.</p>

        <div className="lp-vault__headline-grid">
          <div className="lp-vault__headline-metric">
            <span>Observed house treasury</span>
            <strong>{snapshot ? formatUsd(snapshot.treasuryAssetsUsd) : emptyValue}</strong>
            <small>Global house-book USDC, not segregated LP assets.</small>
          </div>
          <div className="lp-vault__headline-metric">
            <span>Global live-ticket max payout</span>
            <strong>{snapshot ? formatUsd(snapshot.grossUnresolvedPayoutsUsd) : emptyValue}</strong>
            <small>The black-swan payout if every open ticket wins.</small>
          </div>
          <div className="lp-vault__headline-metric">
            <span>Observed house-book coverage</span>
            <strong>{payoutCoverageDisplay}</strong>
            <small>{collateralHealth?.label ?? "Coverage unavailable"}. {collateralHealth?.detail ?? "Waiting for verified reserves."}</small>
          </div>
          <div className="lp-vault__headline-metric">
            <span>Modeled capital surplus <em>(not withdrawable)</em></span>
            <strong>{snapshot ? formatUsd(snapshot.capitalAboveWithdrawalFloorUsd) : emptyValue}</strong>
            <small>Modeled above the 125% floor. No LP withdrawal balance or NAV exists.</small>
          </div>
        </div>
      </section>

      {!snapshot ? (
        <section className="lp-vault__withheld" aria-live="polite">
          <AlertTriangle size={20} />
          <div>
            <h2>{unavailable?.title}</h2>
            <p>{unavailable?.detail} Previous amounts are intentionally not displayed.</p>
            <button className="lp-vault__retry" type="button" onClick={() => setRequestVersion((value) => value + 1)}><RefreshCw size={15} /> Refresh status</button>
          </div>
        </section>
      ) : (
        <section className="lp-vault__transparency" aria-labelledby="capital-breakdown-title">
          <div className="lp-vault__section-heading">
            <div><span className="lp-vault__eyebrow"><Landmark size={14} /> Transparency dashboard</span><h2 id="capital-breakdown-title">Shadow reserve breakdown</h2></div>
            <span className="lp-vault__reconciled"><CheckCircle2 size={16} /> Last reconciled {formatReconciliationAge(snapshot.asOf)}</span>
          </div>
          <p className="lp-vault__scope-note">These are global treasury observations, not LP assets, NAV, or withdrawable balances. LP ownership and returns are not attributed, and the shadow limit does not control customer quotes.</p>

          {collateralHealth ? <div className={`lp-vault__health lp-vault__health--${collateralHealth.tone}`}><ShieldCheck size={19} /><div><strong>{collateralHealth.label}</strong><span>{collateralHealth.detail}</span></div></div> : null}

          {snapshot.custodyDeltaUsd !== 0 ? <div className="lp-vault__delta-warning"><AlertTriangle size={19} /><div><strong>Custody delta detected: {formatUsd(snapshot.custodyDeltaUsd)}</strong><span>Reported treasury assets differ from the reconciliation expectation.</span></div></div> : null}

          <div className="lp-vault__capital-grid">
            <div><span>Senior user obligations</span><strong>{formatUsd(snapshot.seniorUserObligationsUsd)}</strong></div>
            <div><span>Reserved net exposure</span><strong>{formatUsd(snapshot.reservedNetLiabilityUsd)}</strong></div>
            <div><span>Minimum collateral required</span><strong>{formatUsd(snapshot.hardSolvencyFloorUsd)}</strong></div>
            <div><span>25% coverage buffer</span><strong>{formatUsd(snapshot.operatingCoverageBufferUsd)}</strong></div>
            <div><span>Pending basket capacity</span><strong>{formatUsd(snapshot.pendingBasketCapacityChargeUsd)}</strong><small>{formatUsd(snapshot.pendingBasketMaxPayoutUsd)} maximum payout against {formatUsd(snapshot.pendingBasketStakeUsd)} expected stake.</small></div>
            <div><span>Modeled minimum after future LP withdrawals</span><strong>{formatUsd(snapshot.operatingWithdrawalFloorUsd)}</strong></div>
            <div className="lp-vault__hard-capital"><span>Capital after all current payouts</span><strong>{formatUsd(snapshot.hardCapitalUsd)}</strong></div>
          </div>

          <div className="lp-vault__reserve-policy">
            <ShieldCheck size={19} />
            <div>
              <strong>Modeled future LP withdrawal policy</strong>
              <span>If community LP withdrawals launch, user balances and ticket payouts would come first. LP payouts would begin only after final settlement and would have to preserve reserves. Under the proposed policy, a shortfall would pause processing for investigation.</span>
            </div>
          </div>

          <div className="lp-vault__evidence-grid">
            <div className="lp-vault__evidence">
              <span>Source network</span>
              <strong>{data.network.name} <small>Chain {data.network.chainId}</small></strong>
              <div className="lp-vault__links">
                {data.vault?.tokenAddress ? <ExternalValue href={tokenUrl}>USDC token</ExternalValue> : null}
                {data.vault?.treasuryAddress ? <ExternalValue href={treasuryUrl}>Treasury</ExternalValue> : null}
              </div>
            </div>
            <div className="lp-vault__evidence">
              <span>Canonical block</span>
              <strong><ExternalValue href={blockUrl}>#{snapshot.blockNumber}</ExternalValue></strong>
              <div className="lp-vault__hash"><ExternalValue href={blockUrl}>{shortHash(snapshot.blockHash)}</ExternalValue></div>
            </div>
            <div className="lp-vault__evidence">
              <span>Last reconciled</span>
              <strong>{formatDateTime(snapshot.asOf)}</strong>
              <div className="lp-vault__age">Reconciliation age: {formatReconciliationAge(snapshot.asOf)}</div>
              <div className="lp-vault__links"><ExternalValue href={snapshotUrl}>View latest vault state JSON</ExternalValue></div>
            </div>
          </div>

          <div className="lp-vault__gates">
            <Gate label="Observed underwriting gate (shadow only)" value={snapshot.gate.underwriting} />
            <Gate label="Senior user operations" value={snapshot.gate.seniorOperations} />
            <Gate label="LP withdrawals" value={snapshot.gate.lpWithdrawals} />
          </div>
        </section>
      )}
    </section>
  );
}

export default LpVaultView;

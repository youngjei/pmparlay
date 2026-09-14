import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Blocks,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  Landmark,
  LockKeyhole,
  RefreshCw,
  ShieldCheck
} from "lucide-react";
import {
  canShowLpVaultAmounts,
  collateralHealthCopy,
  explorerBaseUrl,
  explorerUrl,
  fetchLpVault,
  formatBasisPoints,
  formatDateTime,
  formatMicroUsdc,
  formatRatio,
  formatReconciliationAge,
  formatUtcCycleCutoff,
  formatUsd,
  gateCopy,
  getLpVaultDisplayState,
  LP_VAULT_ACCOUNTING_CLIENT_MAX_AGE_MS,
  LP_VAULT_CLIENT_MAX_AGE_MS,
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

export const LP_VAULT_SHADOW_COPY = {
  title: "LEGWORK LP Vault",
  promise: "Back LEGWORK tickets through a transparent, rolling economic NAV.",
  banner: "Founder-funded Sepolia shadow · Deposits unavailable"
} as const;

export const LP_VAULT_FUTURE_LIFECYCLE = [
  {
    title: "Custody first, participation next",
    detail: "A future deposit enters custody immediately but remains pending P&L until the next 00:00 UTC cycle, when shares mint at the canonical pre-deposit economic NAV price so entrants neither inherit prior P&L nor dilute active LPs."
  },
  {
    title: "Fixed shares, floating value",
    detail: "Activated shares are fixed and non-transferable. Their estimated USDC value moves with conservative unresolved-liability marks; only authoritative ticket settlements change finalized P&L."
  },
  {
    title: "FIFO, liquidity-gated admission",
    detail: "Withdrawal requests wait in immutable FIFO order and are admitted only when separately tracked redemption liquidity is available. Queued shares remain fully active."
  },
  {
    title: "Active through 72-hour redemption",
    detail: "Admitted shares continue to take dynamic P&L and back new exposure for 72 hours. At the end, the canonical economic-NAV price becomes binding for valuation and burn even if some underlying P&L remains estimated."
  }
] as const;

export const LP_VAULT_LIQUIDITY_COPY = "Future economic NAV will measure the marked value represented by active shares. Redemption liquidity will be a separate reserved-capacity measure used only for FIFO admission; reserving liquidity will not be presented as profit or added to economic NAV.";

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

export function LpVaultView({ endpoint, fetcher }: LpVaultViewProps) {
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
    if (view.kind !== "loaded" || view.data.availability !== "available" || !view.data.snapshot || !view.data.accounting) return;
    const staleAt = Math.min(
      Date.parse(view.data.snapshot.asOf) + LP_VAULT_CLIENT_MAX_AGE_MS,
      Date.parse(view.data.accounting.asOf) + LP_VAULT_ACCOUNTING_CLIENT_MAX_AGE_MS
    );
    const timeout = window.setTimeout(() => setFreshnessVersion((value) => value + 1), Math.max(0, staleAt - Date.now() + 1));
    return () => window.clearTimeout(timeout);
  }, [view]);

  void freshnessVersion;

  if (view.kind === "loading") return <LoadingView />;

  if (view.kind === "error") {
    return (
      <section className="lp-vault" aria-label="LP Vault">
        <section className="lp-vault__hero lp-vault__unavailable" aria-live="polite">
          <div className="lp-vault__eyebrow"><CircleAlert size={14} /> LP Vault status</div>
          <h1>{LP_VAULT_SHADOW_COPY.title}</h1>
          <p className="lp-vault__promise">{LP_VAULT_SHADOW_COPY.promise}</p>
          <div className="lp-vault__status-banner">
            <LockKeyhole aria-hidden="true" size={18} />
            <div><strong>{LP_VAULT_SHADOW_COPY.banner}</strong><span>No public LP funds or actions are enabled.</span></div>
          </div>
          <p>{view.message} No capital amounts are shown without a verified reconciliation.</p>
          <div className="lp-vault__error-actions">
            <button className="lp-vault__connect" type="button" onClick={() => setRequestVersion((value) => value + 1)}><RefreshCw size={17} /> Retry</button>
          </div>
        </section>
      </section>
    );
  }

  const { data } = view;
  const state = getLpVaultDisplayState(data);
  const hasAmounts = canShowLpVaultAmounts(data);
  const snapshot = hasAmounts && data.snapshot ? data.snapshot : null;
  const accounting = hasAmounts && data.accounting ? data.accounting : null;
  const unavailable = state === "ready" ? null : unavailableCopy(state);
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
            <div className="lp-vault__eyebrow"><ShieldCheck size={14} /> LP Vault</div>
            <h1>{LP_VAULT_SHADOW_COPY.title}</h1>
            <p className="lp-vault__promise">{LP_VAULT_SHADOW_COPY.promise}</p>
          </div>
          <div className="lp-vault__network"><Blocks size={15} /> {data.network.name} <span>Chain {data.network.chainId}</span></div>
        </div>

        <div className="lp-vault__status-banner" role="status">
          <LockKeyhole aria-hidden="true" size={18} />
          <div>
            <strong>{LP_VAULT_SHADOW_COPY.banner}</strong>
            <span>This read-only view observes founder test capital. No public LP funds, balances, or actions exist yet.</span>
          </div>
        </div>

        <div className="lp-vault__headline-grid">
          <div className="lp-vault__headline-metric">
            <span>Verified assets</span>
            <strong>{snapshot ? formatUsd(snapshot.treasuryAssetsUsd) : emptyValue}</strong>
            <small>Reconciled test USDC in the observed treasury scope.</small>
          </div>
          <div className="lp-vault__headline-metric">
            <span>Maximum live-ticket payout</span>
            <strong>{snapshot ? formatUsd(snapshot.grossUnresolvedPayoutsUsd) : emptyValue}</strong>
            <small>Full offered payouts reserved with no diversification credit.</small>
          </div>
          <div className="lp-vault__headline-metric">
            <span>Payout coverage</span>
            <strong>{payoutCoverageDisplay}</strong>
            <small>Assets after senior obligations divided by unresolved payouts.</small>
          </div>
          <div className="lp-vault__headline-metric">
            <span>Collateral state</span>
            <strong className="lp-vault__headline-status">{collateralHealth?.label ?? "Unavailable"}</strong>
            <small>{collateralHealth?.detail ?? "Waiting for verified reserve evidence."}</small>
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
            <div><span className="lp-vault__eyebrow"><Landmark size={14} /> Fresh reconciliation</span><h2 id="capital-breakdown-title">Verified reserve state</h2></div>
            <div className="lp-vault__freshness" aria-label="Vault data freshness">
              <span className="lp-vault__reconciled"><CheckCircle2 size={16} /> Reserve current · {formatReconciliationAge(snapshot.asOf)}</span>
              <span className="lp-vault__reconciled"><CheckCircle2 size={16} /> Accounting current · {formatReconciliationAge(accounting!.asOf)}</span>
            </div>
          </div>
          <p className="lp-vault__scope-note">The reserve view uses current reconciliation evidence. Rolling accounting uses its own canonical daily checkpoint and block evidence. This shadow policy does not authorize customer quotes or transfers.</p>

          {snapshot.custodyDeltaUsd !== 0 ? <div className="lp-vault__delta-warning"><AlertTriangle size={19} /><div><strong>Custody delta detected: {formatUsd(snapshot.custodyDeltaUsd)}</strong><span>Reported treasury assets differ from the reconciliation expectation.</span></div></div> : null}

          <section className="lp-vault__accounting" aria-labelledby="rolling-accounting-title">
            <div className="lp-vault__accounting-head">
              <div><span className="lp-vault__eyebrow">Rolling accounting</span><h2 id="rolling-accounting-title">Canonical economic value</h2></div>
              <span>Cycle cutoff {formatUtcCycleCutoff(accounting!.cycleCutoffAt)}</span>
            </div>
            <div className="lp-vault__accounting-grid">
              <div><span>Economic NAV</span><strong>{formatMicroUsdc(accounting!.economicNavMicroUnits)}</strong><small>Value attributable to active shares after conservative liability marks.</small></div>
              <div><span>Share price</span><strong>{formatMicroUsdc(accounting!.sharePriceMicroUnits)}</strong><small>USDC value per whole non-transferable share.</small></div>
              <div><span>Pending activation</span><strong>{formatMicroUsdc(accounting!.pendingActivationMicroUnits)}</strong><small>Excluded from P&amp;L until the next 00:00 UTC cycle.</small></div>
              <div><span>Estimated P&amp;L</span><strong className="lp-vault__estimated">{formatMicroUsdc(accounting!.estimatedPnlMicroUnits, { signed: true })}</strong><small>Includes unresolved market liability marks.</small></div>
              <div><span>Finalized P&amp;L</span><strong>{formatMicroUsdc(accounting!.finalizedPnlMicroUnits, { signed: true })}</strong><small>Recognized only from authoritative ticket settlements.</small></div>
              <div><span>Unresolved liability mark</span><strong>{formatMicroUsdc(accounting!.markedUnresolvedLiabilityMicroUnits)}</strong><small>{formatBasisPoints(accounting!.liabilityMarkCoverageBps)} mark evidence coverage · {formatMicroUsdc(accounting!.fullLiabilityFallbackMicroUnits)} at full-liability fallback.</small></div>
            </div>
          </section>

          <div className="lp-vault__capital-grid">
            <div><span>Senior user obligations</span><strong>{formatUsd(snapshot.seniorUserObligationsUsd)}</strong></div>
            <div><span>Net liability reserve</span><strong>{formatUsd(snapshot.reservedNetLiabilityUsd)}</strong></div>
            <div><span>Minimum collateral required</span><strong>{formatUsd(snapshot.hardSolvencyFloorUsd)}</strong></div>
            <div><span>25% coverage buffer</span><strong>{formatUsd(snapshot.operatingCoverageBufferUsd)}</strong></div>
            <div><span>Pending checkout capacity</span><strong>{formatUsd(snapshot.pendingBasketCapacityChargeUsd)}</strong><small>{formatUsd(snapshot.pendingBasketMaxPayoutUsd)} maximum payout against {formatUsd(snapshot.pendingBasketStakeUsd)} expected stake.</small></div>
            <div><span>Shadow operating reserve floor</span><strong>{formatUsd(snapshot.operatingWithdrawalFloorUsd)}</strong></div>
            <div><span>Capital after all current payouts</span><strong>{formatUsd(snapshot.hardCapitalUsd)}</strong></div>
            <div className="lp-vault__hard-capital"><span>Capacity above reserve floor</span><strong>{formatUsd(snapshot.capitalAboveWithdrawalFloorUsd)}</strong><small>Shadow capacity only. It is not NAV, redemption liquidity, or a withdrawable balance.</small></div>
          </div>

          <section className="lp-vault__lifecycle" aria-labelledby="lp-vault-lifecycle-title">
            <div className="lp-vault__section-heading">
              <div><span className="lp-vault__eyebrow">Future lifecycle</span><h2 id="lp-vault-lifecycle-title">How rolling participation will work</h2></div>
            </div>
            <p className="lp-vault__scope-note">This approved model is not live. It describes the accounting and redemption behavior required before public participation can open.</p>
            <ol className="lp-vault__lifecycle-grid">
              {LP_VAULT_FUTURE_LIFECYCLE.map((item) => (
                <li key={item.title}>
                  <strong>{item.title}</strong>
                  <span>{item.detail}</span>
                </li>
              ))}
            </ol>
            <div className="lp-vault__liquidity-note">
              <ShieldCheck aria-hidden="true" size={19} />
              <div><strong>Value and liquidity stay separate</strong><span>{LP_VAULT_LIQUIDITY_COPY}</span></div>
            </div>
          </section>

          <details className="lp-vault__technical">
            <summary><span><CheckCircle2 aria-hidden="true" size={16} /> Technical evidence and operating gates</span><small>Addresses, block, time, and control state</small></summary>
            <div className="lp-vault__technical-body">
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
                  <span>Source observed</span>
                  <strong>{formatDateTime(snapshot.asOf)}</strong>
                  <div className="lp-vault__age">Processed {formatReconciliationAge(snapshot.processedAt)} · Accounting {formatReconciliationAge(accounting!.asOf)} · Book {accounting!.bookVersion}</div>
                  <div className="lp-vault__links"><ExternalValue href={snapshotUrl}>View latest vault state JSON</ExternalValue></div>
                </div>
              </div>

              <div className="lp-vault__gates">
                <Gate label="Observed underwriting gate (shadow only)" value={snapshot.gate.underwriting} />
                <Gate label="Senior user operations" value={snapshot.gate.seniorOperations} />
                <Gate label="Public LP withdrawals" value={snapshot.gate.lpWithdrawals} />
              </div>
            </div>
          </details>
        </section>
      )}
    </section>
  );
}

export default LpVaultView;

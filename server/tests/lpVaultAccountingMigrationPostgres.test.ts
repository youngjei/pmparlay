import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import {
  INTERNAL_FOUNDER_LP_USER_ID,
  admitNextLpVaultRedemption,
  appendLpVaultAccountingEvent,
  closeDueLpVaultAccountingForReconciliation,
  closeLpVaultAccountingCycle,
  inceptLpVaultAccounting,
  loadLatestVerifiedLpVaultAccounting,
  loadVerifiedLpVaultOwnerAccounting,
  openOrGetLpVaultCycle,
  recognizeLpVaultFeesAndSettlements,
  recordPendingLpVaultDeposit,
  replayLpVaultAccounting,
  requestLpVaultRedemption,
  runDueLpVaultAccountingCycle,
  runLpVaultAccountingTransaction
} from "../db/lpVaultAccountingRepository";
import { FOUNDER_SEPOLIA_SHADOW_VAULT_ID } from "../db/lpVaultRepository";
import { lockFinancialControlGateForMutation } from "../financialGate";

const testDatabaseUrl=process.env.TEST_DATABASE_URL;
const postgresDescribe=testDatabaseUrl?describe:describe.skip;
const migrationsDirectory=path.join(process.cwd(),"server/db/migrations");
const treasury="0x1d4fd58d9fc24c9f3c8da0deb4a05e7d122ef17b";
const token="0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const blockHash=`0x${"a".repeat(64)}`;

async function applyMigrations(client:pg.Client,through?:string){
  const migrations=(await readdir(migrationsDirectory)).filter(name=>name.endsWith(".sql")).sort();
  for(const migration of migrations){
    if(through&&migration>through) break;
    await client.query(await readFile(path.join(migrationsDirectory,migration),"utf8"));
  }
}

function utcCutoff(offsetDays=0){
  const now=new Date();
  return new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+offsetDays));
}

async function seedVault(client:pg.Client){
  await client.query(`INSERT INTO lp_vaults (id,vault_key,display_name,mode,chain_id,currency,treasury_address,
    token_address,capital_source,custody_model) VALUES ($1,'founder-sepolia-shadow','LEGWORK Founder Shadow Vault',
    'shadow',11155111,'USDC',$2,$3,'founder','logical_operating_treasury')`,
  [FOUNDER_SEPOLIA_SHADOW_VAULT_ID,treasury,token]);
}

async function expireFirstCutoffBootstrapWindow(client:Pick<pg.Client|pg.PoolClient,"query">){
  await client.query("UPDATE financial_book_state SET created_at=now()-interval '2 days' WHERE scope='global'");
}

async function seedReconciliation(
  client:Pick<pg.Client|pg.PoolClient,"query">,
  createdAt:Date,
  assets=100_000_000n,
  options:{source?:"worker"|"legacy";launchGate?:"ready"|"blocked";
    operationGate?:"open"|"restricted"|"blocked";scopeTreasury?:string;scopeToken?:string;
    metrics?:Record<string,string>;chainEvidenceAt?:Date;openStakeMicroUnits?:bigint;openReserveMicroUnits?:bigint;
    financialStateHash?:string}={}
){
  const source=options.source??"worker";
  const scopeTreasury=options.scopeTreasury??treasury;
  const scopeToken=options.scopeToken??token;
  const chainEvidenceAt=options.chainEvidenceAt??createdAt;
  const result=await client.query<{id:string}>(`INSERT INTO financial_reconciliation_snapshots (
    chain_id,currency,treasury_assets_micro_units,internal_custody_micro_units,user_available_micro_units,
    user_claimable_micro_units,user_checkout_micro_units,open_stake_micro_units,open_reserve_micro_units,
    pending_withdrawal_micro_units,house_equity_micro_units,unexplained_delta_micro_units,launch_gate,operation_gate,
    gate_reasons,treasury_assets,metrics,observed_block_number,observed_block_hash,source,scope_treasury_address,
    scope_token_address,created_at,financial_book_version,financial_state_hash)
    VALUES (11155111,'USDC',$1,$1,0,0,0,$11,$12,0,$1,0,$7,$8,'[]',$5::jsonb,$9::jsonb,
    123,$2,$10,$3,$4,$6,(SELECT book_version FROM financial_book_state WHERE scope='global'),$13)
    RETURNING id`,[assets.toString(),blockHash,scopeTreasury,scopeToken,JSON.stringify([{
      source:"onchain",chainId:"11155111",treasuryAddress:scopeTreasury,tokenAddress:scopeToken,blockNumber:"123",blockHash,
      blockTimestamp:Math.floor(chainEvidenceAt.getTime()/1000).toString()
    }]),createdAt,options.launchGate??"ready",options.operationGate??"open",JSON.stringify({
      ...(options.metrics??{}),observedBlockTimestamp:Math.floor(chainEvidenceAt.getTime()/1000).toString()
    }),source,(options.openStakeMicroUnits??0n).toString(),(options.openReserveMicroUnits??0n).toString(),
    options.financialStateHash??`sha256:${"b".repeat(64)}`]);
  return result.rows[0].id;
}

async function currentAdmissionMetrics(client:Pick<pg.Client|pg.PoolClient,"query">){
  const result=await client.query<{gross:string;soft_charge:string}>(`SELECT
    (SELECT COALESCE(sum(reserves.offered_payout_micro_units),0)::text FROM ticket_reserves reserves
      WHERE reserves.accounting_mode='house_book_usdc' AND reserves.currency='USDC' AND reserves.status='reserved'
        AND NOT EXISTS (SELECT 1 FROM ticket_settlement_summaries summaries WHERE summaries.ticket_id=reserves.ticket_id)) AS gross,
    (SELECT COALESCE(sum(GREATEST(ceil(quotes.offered_payout_micro_usd::numeric*125/100)::bigint-
      quotes.stake_micro_usd,0)),0)::text FROM quote_payment_exposure_reservations reservations
      JOIN quotes ON quotes.id=reservations.quote_id
      WHERE reservations.status='reserved' AND reservations.expires_at>now()) AS soft_charge`);
  return {grossUnresolvedLiveTicketPayoutMicroUnits:result.rows[0].gross,
    softReservationOperatingChargeMicroUnits:result.rows[0].soft_charge};
}

async function admitWithFreshReconciliation(
  pool:pg.Pool,
  options:{assets?:bigint;createdAt?:Date;source?:"worker"|"legacy";launchGate?:"ready"|"blocked";
    operationGate?:"open"|"restricted"|"blocked";scopeTreasury?:string;scopeToken?:string;chainEvidenceAt?:Date}={}
){
  const client=await pool.connect();
  try{
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await lockFinancialControlGateForMutation(client);
    await client.query("SELECT set_config('legwork.financial_global_exclusive_lock', 'held', true)");
    const transactionNow=options.createdAt??(await client.query<{now:Date}>("SELECT now() AS now")).rows[0].now;
    const reconciliationSnapshotId=await seedReconciliation(client,transactionNow,options.assets??100_000_000n,{
      ...options,metrics:await currentAdmissionMetrics(client)
    });
    const result=await admitNextLpVaultRedemption(client,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,reconciliationSnapshotId});
    await client.query("COMMIT");
    return {reconciliationSnapshotId,result};
  }catch(error){
    await client.query("ROLLBACK").catch(()=>undefined);
    throw error;
  }finally{client.release();}
}

async function closeHistoricalCycle(
  pool:pg.Pool,
  input:{cutoff:Date;reconciliationId:string;ticketMarks?:Array<{
    ticketId:string;markedLiabilityMicroUnits:bigint;markSource:"gross_payout_fallback";
    fallbackReason?:string;evidenceTime:Date;
  }>}
){
  return await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,async client=>{
    const cycle=await openOrGetLpVaultCycle(client,{
      vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
      cutoffDate:input.cutoff.toISOString().slice(0,10)
    });
    return await closeLpVaultAccountingCycle(client,{
      vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
      cycleId:cycle.id,
      reconciliationId:input.reconciliationId,
      sourceMaxAgeMs:300_000,
      ticketMarks:input.ticketMarks??[]
    });
  },pool);
}

async function closeTwoCyclesWithExpense(
  pool:pg.Pool,
  client:pg.Client,
  eventAmountMicroUnits:string
){
  await seedVault(client);
  const firstCutoff=utcCutoff(-1); const secondCutoff=utcCutoff();
  const firstReconciliation=await seedReconciliation(client,new Date(firstCutoff.getTime()+60_000));
  await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,async accountingClient=>{
    await inceptLpVaultAccounting(accountingClient,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
      reconciliationId:firstReconciliation});
    const cycle=await openOrGetLpVaultCycle(accountingClient,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
      cutoffDate:firstCutoff.toISOString().slice(0,10)});
    await closeLpVaultAccountingCycle(accountingClient,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,cycleId:cycle.id,
      reconciliationId:firstReconciliation,sourceMaxAgeMs:300_000,ticketMarks:[]});
  },pool);
  await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,async accountingClient=>{
    const expenseId=randomUUID();
    const event=await appendLpVaultAccountingEvent(accountingClient,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
      eventType:"expense_accrued",entityId:expenseId,payload:{
        amountMicroUnits:eventAmountMicroUnits,approvalReference:"replay-expense"
      }});
    await accountingClient.query(`INSERT INTO lp_vault_approved_expense_accruals (
      id,vault_id,amount_micro_units,accrued_on,approval_reference,evidence,accounting_event_id
    ) VALUES ($1,$2,31,$3::date,'replay-expense',$4::jsonb,$5)`,[
      expenseId,FOUNDER_SEPOLIA_SHADOW_VAULT_ID,secondCutoff.toISOString().slice(0,10),
      JSON.stringify({source:"postgres-replay-test"}),event.id
    ]);
  },pool);
  const secondReconciliation=await seedReconciliation(client,new Date(secondCutoff.getTime()+60_000));
  await closeHistoricalCycle(pool,{cutoff:secondCutoff,reconciliationId:secondReconciliation});
}

async function assertExactCycleConservation(pool:pg.Pool,expectedCycles:number){
  const rows=await pool.query<{
    cutoff_date:string;checkpoint_difference:string;closing_difference:string;
  }>(`SELECT cycles.cutoff_date::text,
      (checkpoints.gross_assets_micro_units-liabilities.nav_deductions_micro_units-
        checkpoints.net_asset_value_micro_units)::text AS checkpoint_difference,
      (closing.closing_economic_nav_micro_units-(checkpoints.net_asset_value_micro_units+
        closing.activated_deposit_micro_units-closing.matured_redemption_micro_units-
        closing.protocol_rounding_dust_micro_units))::text AS closing_difference
    FROM lp_vault_daily_cycles cycles
    JOIN lp_vault_liability_marks liabilities ON liabilities.cycle_id=cycles.id
    JOIN lp_vault_nav_checkpoints checkpoints ON checkpoints.cycle_id=cycles.id
    JOIN lp_vault_cycle_closing_states closing ON closing.cycle_id=cycles.id
    WHERE cycles.vault_id=$1 AND cycles.status='closed'
    ORDER BY cycles.cutoff_date`,[FOUNDER_SEPOLIA_SHADOW_VAULT_ID]);
  expect(rows.rows).toHaveLength(expectedCycles);
  expect(rows.rows.map(row=>({checkpoint:row.checkpoint_difference,closing:row.closing_difference})))
    .toEqual(Array.from({length:expectedCycles},()=>({checkpoint:"0",closing:"0"})));
  const replay=await replayLpVaultAccounting(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,pool);
  const latest=await loadLatestVerifiedLpVaultAccounting(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,pool);
  expect(replay.checkpointCount).toBe(expectedCycles);
  expect(replay.replayedShareSupplyUnits).toBe(latest?.activeShareUnits);
  expect(replay.economicNavMicroUnits).toBe(latest?.economicNavMicroUnits);
  expect(replay.grossAssetsMicroUnits-replay.navDeductionsMicroUnits-replay.economicNavMicroUnits).toBe(0n);
}

async function backdatePendingDepositForTest(
  client:pg.Client,
  input:{depositId:string;createdAt:Date;eligibleAfterCutoff:Date}
){
  // PostgreSQL's now() cannot be advanced for one test session. This is the only
  // trigger bypass: it moves immutable request time fields into a historical
  // post-cutoff window; activation and all accounting triggers remain enabled.
  await client.query("ALTER TABLE lp_vault_pending_deposits DISABLE TRIGGER lp_vault_pending_deposits_transition_trigger");
  try{
    await client.query(`UPDATE lp_vault_pending_deposits SET created_at=$2,eligible_after_cutoff=$3::date WHERE id=$1`,[
      input.depositId,input.createdAt,input.eligibleAfterCutoff.toISOString().slice(0,10)
    ]);
  }finally{
    await client.query("ALTER TABLE lp_vault_pending_deposits ENABLE TRIGGER lp_vault_pending_deposits_transition_trigger");
  }
}

async function backdateRedemptionWindowForTest(
  client:pg.Client,
  input:{redemptionRequestId:string;redemptionEndsAt:Date}
){
  const redemptionStartsAt=new Date(input.redemptionEndsAt.getTime()-72*60*60_000);
  // PostgreSQL's wall clock cannot be rewound. Move the request window and its
  // append-only status evidence together so the canonical reconciliation sees
  // the same admitted/redeeming chronology it would have seen in production.
  await client.query("ALTER TABLE lp_vault_redemption_requests DISABLE TRIGGER lp_vault_redemption_requests_transition_trigger");
  await client.query("ALTER TABLE lp_vault_redemption_request_history DISABLE TRIGGER lp_vault_redemption_request_history_append_only_trigger");
  await client.query("ALTER TABLE lp_vault_redemption_reserves DISABLE TRIGGER lp_vault_redemption_reserves_append_only_trigger");
  try{
    await client.query(`UPDATE lp_vault_redemption_requests SET requested_at=$2::timestamptz-interval '1 millisecond',
      redemption_starts_at=$2,redemption_ends_at=$3,redeeming_at=$2 WHERE id=$1`,
    [input.redemptionRequestId,redemptionStartsAt,input.redemptionEndsAt]);
    await client.query(`UPDATE lp_vault_redemption_request_history SET recorded_at=CASE to_status
        WHEN 'queued' THEN $2::timestamptz-interval '1 millisecond'
        WHEN 'admitted' THEN $2::timestamptz
        WHEN 'redeeming' THEN $2::timestamptz+interval '1 millisecond'
        ELSE recorded_at END
      WHERE redemption_request_id=$1 AND to_status IN ('queued','admitted','redeeming')`,
    [input.redemptionRequestId,redemptionStartsAt]);
    await client.query("UPDATE lp_vault_redemption_reserves SET created_at=$2 WHERE redemption_request_id=$1",
      [input.redemptionRequestId,redemptionStartsAt]);
  }finally{
    await client.query("ALTER TABLE lp_vault_redemption_reserves ENABLE TRIGGER lp_vault_redemption_reserves_append_only_trigger");
    await client.query("ALTER TABLE lp_vault_redemption_request_history ENABLE TRIGGER lp_vault_redemption_request_history_append_only_trigger");
    await client.query("ALTER TABLE lp_vault_redemption_requests ENABLE TRIGGER lp_vault_redemption_requests_transition_trigger");
  }
}

async function seedHouseBookTicketReserve(
  client:pg.Client,
  createdAt:Date,
  terms:{stakeMicroUnits?:bigint;offeredPayoutMicroUnits?:bigint;operationFeeMicroUnits?:bigint}={}
){
  const stakeMicroUnits=terms.stakeMicroUnits??1_000_000n;
  const offeredPayoutMicroUnits=terms.offeredPayoutMicroUnits??2_000_000n;
  const operationFeeMicroUnits=terms.operationFeeMicroUnits??0n;
  const ids={user:randomUUID(),policy:randomUUID(),market:randomUUID(),outcome:randomUUID(),snapshot:randomUUID(),
    quote:randomUUID(),quoteLeg:randomUUID(),ticket:randomUUID(),ticketLeg:randomUUID(),reserve:randomUUID()};
  const conditionId=`0x${randomUUID().replaceAll("-","").padEnd(64,"0")}`;
  await client.query("INSERT INTO users (id,email) VALUES ($1,$2)",[ids.user,`${ids.user}@example.test`]);
  await client.query(`INSERT INTO policy_versions (id,version,description,policy)
    VALUES ($1,$2,'LP accounting settlement fixture','{}'::jsonb)`,[ids.policy,`lp-accounting-${ids.policy}`]);
  await client.query(`INSERT INTO markets (id,source,source_market_id,condition_id,question,market_url,category,end_date)
    VALUES ($1,'polymarket',$2,$3,'Will this accounting fixture resolve Yes?',$4,'Other',$5)`,
  [ids.market,`lp-accounting-${ids.market}`,conditionId,`https://example.test/${ids.market}`,createdAt]);
  await client.query("INSERT INTO market_outcomes (id,market_id,outcome,token_id) VALUES ($1,$2,'Yes',$3)",
    [ids.outcome,ids.market,randomUUID().replaceAll("-","")]);
  await client.query(`INSERT INTO market_snapshots (id,market_id,source_response_hash,raw,captured_at)
    VALUES ($1,$2,$3,$4::jsonb,$5)`,[ids.snapshot,ids.market,`snapshot-${ids.snapshot}`,JSON.stringify({fixture:true}),createdAt]);
  await client.query(`INSERT INTO quotes (id,user_id,policy_version_id,status,stake_micro_usd,operation_fee_micro_usd,
    spread_bps,implied_probability_bps,offered_payout_micro_usd,expires_at,created_at)
    VALUES ($1,$2,$3,'quoted',$4,$5,0,5000,$6,$7,$8)`,
  [ids.quote,ids.user,ids.policy,stakeMicroUnits.toString(),operationFeeMicroUnits.toString(),
    offeredPayoutMicroUnits.toString(),new Date(createdAt.getTime()+3_600_000),createdAt]);
  await client.query(`INSERT INTO quote_legs (id,quote_id,market_id,outcome_id,market_snapshot_id,outcome,quoted_price_bps,created_at)
    VALUES ($1,$2,$3,$4,$5,'Yes',5000,$6)`,[ids.quoteLeg,ids.quote,ids.market,ids.outcome,ids.snapshot,createdAt]);
  await client.query("UPDATE quotes SET status='accepted',accepted_at=$2 WHERE id=$1",[ids.quote,createdAt]);
  await client.query(`INSERT INTO tickets (id,user_id,quote_id,status,accounting_mode,funding_currency,created_at,updated_at)
    VALUES ($1,$2,$3,'live','house_book_usdc','USDC',$4,$4)`,[ids.ticket,ids.user,ids.quote,createdAt]);
  await client.query(`INSERT INTO ticket_legs (id,ticket_id,quote_leg_id,status,settlement_due_at,created_at)
    VALUES ($1,$2,$3,'pending',$4,$4)`,[ids.ticketLeg,ids.ticket,ids.quoteLeg,createdAt]);
  await client.query(`INSERT INTO ticket_reserves (id,ticket_id,user_id,accounting_mode,currency,stake_micro_units,
    operation_fee_micro_units,offered_payout_micro_units,net_liability_micro_units,status,purchase_transaction_id,
    reserve_transaction_id,created_at,updated_at)
    VALUES ($1,$2,$3,'house_book_usdc','USDC',$4,$5,$6,$7,'reserved',$8,$9,$10,$10)`,
  [ids.reserve,ids.ticket,ids.user,stakeMicroUnits.toString(),operationFeeMicroUnits.toString(),
    offeredPayoutMicroUnits.toString(),(offeredPayoutMicroUnits-stakeMicroUnits).toString(),
    randomUUID(),randomUUID(),createdAt]);
  return ids;
}

async function seedSoftExposureReservation(
  client:pg.Client,
  input:{userId:string;policyId:string;stakeMicroUnits:bigint;offeredPayoutMicroUnits:bigint}
){
  const quoteId=randomUUID(); const paymentIntentId=randomUUID();
  const expiresAt=new Date(Date.now()+3_600_000);
  await client.query(`INSERT INTO quotes (id,user_id,policy_version_id,status,stake_micro_usd,operation_fee_micro_usd,
    spread_bps,implied_probability_bps,offered_payout_micro_usd,expires_at)
    VALUES ($1,$2,$3,'quoted',$4,0,0,5000,$5,$6)`,
  [quoteId,input.userId,input.policyId,input.stakeMicroUnits.toString(),input.offeredPayoutMicroUnits.toString(),expiresAt]);
  await client.query(`INSERT INTO quote_payment_intents (
    id,quote_id,user_id,chain_id,treasury_address,usdc_contract_address,amount_micro_units,required_confirmations,
    status,expires_at,submission_deadline_at,estimated_payout_micro_usd,min_final_payout_micro_usd
  ) VALUES ($1,$2,$3,11155111,$4,$5,$6,12,'pending',$7,$7,$8,$8)`,
  [paymentIntentId,quoteId,input.userId,treasury,token,input.stakeMicroUnits.toString(),expiresAt,
    input.offeredPayoutMicroUnits.toString()]);
  await client.query(`INSERT INTO quote_payment_exposure_reservations (
    payment_intent_id,quote_id,user_id,liability_micro_usd,status,expires_at
  ) VALUES ($1,$2,$3,0,'reserved',$4)`,[paymentIntentId,quoteId,input.userId,expiresAt]);
}

async function settleHouseBookTicketAsLost(client:pg.Client,ids:Awaited<ReturnType<typeof seedHouseBookTicketReserve>>,
  settledAt:Date){
  const releaseTransactionId=randomUUID();
  await client.query("UPDATE ticket_legs SET status='lost',settled_at=$2 WHERE id=$1",[ids.ticketLeg,settledAt]);
  await client.query("UPDATE tickets SET status='lost',updated_at=$2 WHERE id=$1",[ids.ticket,settledAt]);
  await client.query(`UPDATE ticket_reserves SET status='released',release_transaction_id=$2,updated_at=$3 WHERE id=$1`,
    [ids.reserve,releaseTransactionId,settledAt]);
  const summary=await client.query<{id:string}>(`INSERT INTO ticket_settlement_summaries (ticket_id,final_status,
    calculation_version,stake_micro_units,original_offered_payout_micro_units,final_payout_micro_units,
    operation_fee_micro_units,calculation,reserve_release_transaction_id,created_at)
    VALUES ($1,'lost','settlement-v2',1000000,2000000,0,0,$2::jsonb,$3,$4) RETURNING id`,
  [ids.ticket,JSON.stringify({isFinal:true,finalStatus:"lost",finalPayoutMicroUsdc:"0",version:"settlement-v2"}),
    releaseTransactionId,settledAt]);
  return summary.rows[0].id;
}

async function withSchema(context:TestContext,run:(pool:pg.Pool,client:pg.Client)=>Promise<void>){
  if(!testDatabaseUrl){context.skip();return;}
  if(process.env.DATABASE_URL===testDatabaseUrl) throw new Error("TEST_DATABASE_URL must not equal DATABASE_URL");
  const admin=new pg.Client({connectionString:testDatabaseUrl}); await admin.connect();
  const schema=`lp_accounting_${randomUUID().replaceAll("-","")}`;
  try{
    await admin.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await admin.query("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
    await admin.query(`CREATE SCHEMA ${schema}`); await admin.query(`SET search_path TO ${schema},public`);
    await applyMigrations(admin);
    const pool=new pg.Pool({connectionString:testDatabaseUrl,max:6,options:`-c search_path=${schema},public`});
    try{await run(pool,admin);}finally{await pool.end();}
  }finally{
    await admin.query("SET search_path TO public"); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
  }
}

postgresDescribe("rolling LP vault accounting repository",()=>{
  it("upgrades a non-empty append-only reconciliation database from 0048",async context=>{
    if(!testDatabaseUrl){context.skip();return;}
    const admin=new pg.Client({connectionString:testDatabaseUrl}); await admin.connect();
    const schema=`lp_upgrade_${randomUUID().replaceAll("-","")}`;
    try{
      await admin.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
      await admin.query("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
      await admin.query(`CREATE SCHEMA ${schema}`); await admin.query(`SET search_path TO ${schema},public`);
      await applyMigrations(admin,"0048_lp_vault_rolling_accounting.sql");
      const legacyId=randomUUID();
      await admin.query(`INSERT INTO financial_reconciliation_snapshots (
        id,chain_id,currency,treasury_assets_micro_units,internal_custody_micro_units,user_available_micro_units,
        user_claimable_micro_units,user_checkout_micro_units,open_stake_micro_units,open_reserve_micro_units,
        pending_withdrawal_micro_units,house_equity_micro_units,unexplained_delta_micro_units,launch_gate,operation_gate,
        gate_reasons,treasury_assets,metrics,observed_block_number,observed_block_hash,source,scope_treasury_address,
        scope_token_address)
        VALUES ($1,11155111,'USDC',100000000,100000000,0,0,0,0,0,0,100000000,0,'ready','open','[]',$2::jsonb,
          $3::jsonb,123,$4,'worker',$5,$6)`,[legacyId,JSON.stringify([{
          source:"onchain",chainId:"11155111",treasuryAddress:treasury,tokenAddress:token,
          blockNumber:"123",blockHash,balanceMicroUnits:"100000000"
        }]),JSON.stringify({observedBlockTimestamp:"1"}),blockHash,treasury,token]);
      await seedVault(admin);
      const userId=randomUUID();
      const positionId=randomUUID();
      const requestId=randomUUID();
      const waitingId=randomUUID();
      await admin.query("INSERT INTO users (id,email) VALUES ($1,$2)",[userId,`${userId}@example.test`]);
      await admin.query("INSERT INTO lp_vault_share_positions (id,vault_id,user_id) VALUES ($1,$2,$3)",
        [positionId,FOUNDER_SEPOLIA_SHADOW_VAULT_ID,userId]);
      const requestedEvent=await appendLpVaultAccountingEvent(admin,{
        vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
        eventType:"redemption_requested",
        entityId:requestId,
        payload:{userId,requestedShareUnits:"1000000000000000000"}
      });
      await admin.query(`INSERT INTO lp_vault_redemption_requests (
        id,vault_id,position_id,requested_share_units,request_payload_hash,status,accounting_event_id
      ) VALUES ($1,$2,$3,1000000000000000000,$4,'queued',$5)`,[
        requestId,FOUNDER_SEPOLIA_SHADOW_VAULT_ID,positionId,`sha256:${"a".repeat(64)}`,requestedEvent.id
      ]);
      const waitingEvent=await appendLpVaultAccountingEvent(admin,{
        vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
        eventType:"redemption_waiting",
        entityId:waitingId,
        payload:{
          requestId,
          reconciliationSnapshotId:legacyId,
          requiredLiquidityMicroUnits:"1000000",
          availableLiquidityBeforeMicroUnits:"500000"
        }
      });
      await admin.query("UPDATE lp_vault_redemption_requests SET status='waiting_liquidity' WHERE id=$1",[requestId]);
      await admin.query(await readFile(path.join(migrationsDirectory,"0049_lp_vault_accounting_hardening.sql"),"utf8"));
      const upgraded=await admin.query<{financial_book_version:string;financial_state_hash:string|null}>(
        `SELECT financial_book_version::text,financial_state_hash FROM financial_reconciliation_snapshots WHERE id=$1`,[legacyId]
      );
      expect(upgraded.rows[0]).toEqual({financial_book_version:"0",financial_state_hash:null});
      const waitingEvidence=await admin.query<{request_id:string;reconciliation_id:string;required:string;available:string}>(
        `SELECT redemption_request_id::text AS request_id,
          source_reconciliation_snapshot_id::text AS reconciliation_id,
          required_liquidity_micro_units::text AS required,
          available_liquidity_before_micro_units::text AS available
         FROM lp_vault_redemption_waiting_evidence WHERE accounting_event_id=$1`,[waitingEvent.id]
      );
      expect(waitingEvidence.rows[0]).toEqual({
        request_id:requestId,
        reconciliation_id:legacyId,
        required:"1000000",
        available:"500000"
      });
    }finally{
      await admin.query("SET search_path TO public");
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },30_000);

  it("replays a canonical immutable expense projection",async context=>{
    await withSchema(context,async(pool,client)=>{
      await closeTwoCyclesWithExpense(pool,client,"31");
      await expect(replayLpVaultAccounting(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,pool)).resolves.toMatchObject({
        checkpointCount:2,economicNavMicroUnits:99_999_969n
      });
    });
  },20_000);

  it("rejects an expense event whose payload amount differs from immutable expense evidence",async context=>{
    await withSchema(context,async(pool,client)=>{
      await closeTwoCyclesWithExpense(pool,client,"30");
      await expect(replayLpVaultAccounting(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,pool))
        .rejects.toThrow("lp_vault_accounting_direct_projection_mismatch");
    });
  },20_000);

  it("advances the financial book only for committed source mutations",async context=>{
    await withSchema(context,async(_pool,client)=>{
      const accountId=randomUUID();
      await client.query(`INSERT INTO ledger_accounts (id,account_type,currency)
        VALUES ($1,'house_usdc_operating','USDC')`,[accountId]);
      const initial=await client.query<{book_version:string}>(
        "SELECT book_version::text FROM financial_book_state WHERE scope='global'"
      );
      await client.query("BEGIN");
      await client.query(`INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_units,currency,memo)
        VALUES ($1,$2,1,'USDC','book version commit'),($1,$2,-1,'USDC','book version commit')`,
      [randomUUID(),accountId]);
      await client.query("COMMIT");
      const committed=await client.query<{book_version:string}>(
        "SELECT book_version::text FROM financial_book_state WHERE scope='global'"
      );
      expect(BigInt(committed.rows[0].book_version)).toBe(BigInt(initial.rows[0].book_version)+1n);

      await client.query("BEGIN");
      await client.query(`INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_units,currency,memo)
        VALUES ($1,$2,1,'USDC','book version rollback'),($1,$2,-1,'USDC','book version rollback')`,
      [randomUUID(),accountId]);
      await client.query("ROLLBACK");
      const rolledBack=await client.query<{book_version:string}>(
        "SELECT book_version::text FROM financial_book_state WHERE scope='global'"
      );
      expect(rolledBack.rows[0].book_version).toBe(committed.rows[0].book_version);
    });
  },15_000);

  it("reports a healthy waiting state before a new installation's first UTC cutoff",async context=>{
    await withSchema(context,async(pool,client)=>{
      await seedVault(client);
      const result=await runDueLpVaultAccountingCycle({queryable:pool});
      expect(result).toMatchObject({
        status:"waiting_first_cutoff",
        vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
        cutoffDate:utcCutoff(1).toISOString().slice(0,10)
      });
    });
  },15_000);

  it("rejects a close when financial state changed after reconciliation",async context=>{
    await withSchema(context,async(pool,client)=>{
      await seedVault(client);
      const cutoff=utcCutoff();
      const reconciliationId=await seedReconciliation(client,new Date(cutoff.getTime()+60_000));
      const accountId=randomUUID();
      await client.query(`INSERT INTO ledger_accounts (id,account_type,currency)
        VALUES ($1,'house_usdc_operating','USDC')`,[accountId]);
      await client.query(`INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_units,currency,memo)
        VALUES ($1,$2,1,'USDC','stale close'),($1,$2,-1,'USDC','stale close')`,[randomUUID(),accountId]);
      await expect(runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,async accountingClient=>{
        const cycle=await openOrGetLpVaultCycle(accountingClient,{
          vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,cutoffDate:cutoff.toISOString().slice(0,10)
        });
        return await closeLpVaultAccountingCycle(accountingClient,{
          vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,cycleId:cycle.id,reconciliationId,
          sourceMaxAgeMs:300_000,ticketMarks:[]
        });
      },pool)).rejects.toThrow("lp_vault_reconciliation_book_version_stale");
      const cycles=await pool.query<{count:string}>("SELECT count(*)::text AS count FROM lp_vault_daily_cycles");
      expect(cycles.rows[0].count).toBe("0");
    });
  },15_000);

  it("closes from the reconciliation transaction before later financial activity",async context=>{
    await withSchema(context,async(pool,client)=>{
      await seedVault(client);
      const cutoff=utcCutoff();
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await lockFinancialControlGateForMutation(client as unknown as pg.PoolClient);
      await client.query("SELECT set_config('legwork.financial_global_exclusive_lock', 'held', true)");
      const reconciliationId=await seedReconciliation(client,new Date(cutoff.getTime()+60_000));
      const result=await closeDueLpVaultAccountingForReconciliation(client as unknown as pg.PoolClient,reconciliationId);
      await client.query("COMMIT");
      expect(result?.status).toBe("created");
      if(result?.status!=="created") throw new Error("expected_created_cycle");

      const accountId=randomUUID();
      await client.query(`INSERT INTO ledger_accounts (id,account_type,currency)
        VALUES ($1,'house_usdc_operating','USDC')`,[accountId]);
      await client.query(`INSERT INTO ledger_entries (transaction_id,account_id,amount_micro_units,currency,memo)
        VALUES ($1,$2,1,'USDC','post-close activity'),($1,$2,-1,'USDC','post-close activity')`,[randomUUID(),accountId]);
      const cycle=await pool.query<{status:string}>(`SELECT status FROM lp_vault_daily_cycles WHERE id=$1`,[result!.cycleId]);
      expect(cycle.rows[0].status).toBe("closed");
    });
  },15_000);

  it("recovers a missed cutoff only from unchanged bracketing financial evidence",async context=>{
    await withSchema(context,async(pool,client)=>{
      await seedVault(client);
      const cutoff=utcCutoff();
      const beforeId=await seedReconciliation(client,new Date(cutoff.getTime()-60_000));
      await seedReconciliation(client,new Date(cutoff.getTime()+10*60_000));
      const result=await runDueLpVaultAccountingCycle({queryable:pool});
      expect(result.status).toBe("created");
      if(result.status!=="created") throw new Error("expected_created_cycle");
      const cycle=await pool.query<{close_mode:string;source_delay_ms:string;recovery_before_snapshot_id:string}>(
        `SELECT close_mode,source_delay_ms::text,recovery_before_snapshot_id::text
         FROM lp_vault_daily_cycles WHERE id=$1`,[result.cycleId]
      );
      expect(cycle.rows[0]).toEqual({
        close_mode:"unchanged_state_recovery",
        source_delay_ms:String(10*60_000),
        recovery_before_snapshot_id:beforeId
      });
    });
  },15_000);

  it("recovers a missed cutoff while conservatively marking an unresolved ticket",async context=>{
    await withSchema(context,async(pool,client)=>{
      await seedVault(client);
      const cutoff=utcCutoff();
      const priorCutoff=utcCutoff(-1);
      const inceptionReconciliationId=await seedReconciliation(client,new Date(priorCutoff.getTime()+60_000));
      await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,async accountingClient=>{
        await inceptLpVaultAccounting(accountingClient,{
          vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,reconciliationId:inceptionReconciliationId
        });
      },pool);
      await closeHistoricalCycle(pool,{cutoff:priorCutoff,reconciliationId:inceptionReconciliationId});

      const ticket=await seedHouseBookTicketReserve(client,new Date(cutoff.getTime()-120_000));
      await seedReconciliation(client,new Date(cutoff.getTime()-60_000),100_000_000n,{
        openStakeMicroUnits:1_000_000n,openReserveMicroUnits:2_000_000n
      });
      await seedReconciliation(client,new Date(cutoff.getTime()+10*60_000),100_000_000n,{
        openStakeMicroUnits:1_000_000n,openReserveMicroUnits:2_000_000n
      });
      const result=await runDueLpVaultAccountingCycle({queryable:pool});
      expect(result.status).toBe("created");
      if(result.status!=="created") throw new Error("expected_created_cycle");
      const marks=await pool.query<{ticket_id:string;marked:string;evidence_time:Date}>(
        `SELECT ticket_id,marked_liability_micro_units::text AS marked,evidence_time
         FROM lp_vault_ticket_liability_marks WHERE cycle_id=$1`,[result.cycleId]
      );
      expect(marks.rows).toHaveLength(1);
      expect(marks.rows[0].ticket_id).toBe(ticket.ticket);
      expect(marks.rows[0].marked).toBe("2000000");
      expect(marks.rows[0].evidence_time.getTime()).toBe(cutoff.getTime()+10*60_000);
    });
  },20_000);

  it("fails closed when missed-cutoff bracketing state hashes differ",async context=>{
    await withSchema(context,async(pool,client)=>{
      await seedVault(client);
      await expireFirstCutoffBootstrapWindow(client);
      const cutoff=utcCutoff();
      await seedReconciliation(client,new Date(cutoff.getTime()-60_000),100_000_000n,{
        financialStateHash:`sha256:${"b".repeat(64)}`
      });
      await seedReconciliation(client,new Date(cutoff.getTime()+10*60_000),100_000_000n,{
        financialStateHash:`sha256:${"c".repeat(64)}`
      });
      await expect(runDueLpVaultAccountingCycle({queryable:pool}))
        .rejects.toThrow("lp_vault_due_cycle_source_unavailable");
      const cycles=await pool.query<{count:string}>("SELECT count(*)::text AS count FROM lp_vault_daily_cycles");
      expect(cycles.rows[0].count).toBe("0");
    });
  },15_000);

  it("closes founder genesis once under concurrency and replays exact closing state",async context=>{
    await withSchema(context,async(pool,client)=>{
      await seedVault(client);
      await seedReconciliation(client,new Date(utcCutoff().getTime()+60_000));
      const results=await Promise.all(Array.from({length:12},()=>runDueLpVaultAccountingCycle({queryable:pool})));
      expect(results.filter(result=>result.status==="created")).toHaveLength(1);
      expect(results.filter(result=>result.status==="already_closed")).toHaveLength(11);
      const created=results.find(result=>result.status==="created");
      if(!created||created.status!=="created") throw new Error("expected_created_cycle");
      const accounting=await loadLatestVerifiedLpVaultAccounting(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,pool);
      expect(accounting?.economicNavMicroUnits).toBe(100_000_000n);
      expect(accounting?.activeShareUnits).toBe(100_000_000_000_000_000_000n);
      expect(accounting?.bookVersion).toBe(BigInt(created.bookVersion));
      const replay=await replayLpVaultAccounting(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,pool);
      expect(replay.replayedShareSupplyUnits).toBe(accounting?.activeShareUnits);
      expect(replay.economicNavMicroUnits).toBe(100_000_000n);
      expect(replay.lastBookVersion).toBe(accounting?.bookVersion);
      expect(replay.replayedShareSupplyUnits).toBeGreaterThan(9_223_372_036_854_775_807n);
      const owner=await loadVerifiedLpVaultOwnerAccounting(
        FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
        INTERNAL_FOUNDER_LP_USER_ID,
        pool,
        {now:new Date()}
      );
      expect(owner).toMatchObject({
        status:"available",
        activeShareUnits:100_000_000_000_000_000_000n,
        remainingCostBasisMicroUnits:100_000_000n,
        currentPositionValueMicroUnits:100_000_000n,
        estimatedPnlMicroUnits:0n
      });
      const counts=await pool.query<{cycles:string;checkpoints:string;closings:string;mints:string}>(`SELECT
        (SELECT count(*) FROM lp_vault_daily_cycles)::text AS cycles,
        (SELECT count(*) FROM lp_vault_nav_checkpoints)::text AS checkpoints,
        (SELECT count(*) FROM lp_vault_cycle_closing_states)::text AS closings,
        (SELECT count(*) FROM lp_vault_share_events WHERE event_type='mint')::text AS mints`);
      expect(counts.rows[0]).toEqual({cycles:"1",checkpoints:"1",closings:"1",mints:"1"});
      await expect(pool.query(`UPDATE lp_vault_accounting_events SET payload='{}' WHERE vault_id=$1`,
        [FOUNDER_SEPOLIA_SHADOW_VAULT_ID])).rejects.toThrow("lp_vault_accounting_events_is_append_only");
    });
  });

  it("rejects idempotency payload conflicts and creates one queued request and reserve",async context=>{
    await withSchema(context,async(pool,client)=>{
      await seedVault(client); await seedReconciliation(client,new Date(utcCutoff().getTime()+60_000));
      await runDueLpVaultAccountingCycle({queryable:pool});
      const userId=INTERNAL_FOUNDER_LP_USER_ID;
      const first=await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,c=>recordPendingLpVaultDeposit(c,{
        vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,userId,amountMicroUnits:1_000_000n,sourceReference:"test:deposit:1",idempotencyKey:"deposit-1"}),pool);
      const replayed=await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,c=>recordPendingLpVaultDeposit(c,{
        vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,userId,amountMicroUnits:1_000_000n,sourceReference:"test:deposit:1",idempotencyKey:"deposit-1"}),pool);
      expect(first.id).toBe(replayed.id); expect(replayed.idempotentReplay).toBe(true);
      await expect(runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,c=>recordPendingLpVaultDeposit(c,{
        vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,userId,amountMicroUnits:2_000_000n,sourceReference:"test:deposit:1",idempotencyKey:"deposit-1"}),pool))
        .rejects.toThrow("lp_vault_accounting_idempotency_conflict");
      const requested=await Promise.all([1,2].map(()=>runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,c=>
        requestLpVaultRedemption(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,userId,requestedShareUnits:1_000_000_000_000_000_000n,
          idempotencyKey:"redeem-1"}),pool)));
      expect(new Set(requested.map(value=>value.id)).size).toBe(1);
      const admitted=await Promise.all(Array.from({length:12},()=>admitWithFreshReconciliation(pool)));
      expect(admitted.filter(value=>value.result.status==="redeeming")).toHaveLength(1);
      expect(admitted.filter(value=>value.result.status==="none")).toHaveLength(11);
      const reserveCount=await pool.query<{value:string}>("SELECT count(*)::text AS value FROM lp_vault_redemption_reserves");
      expect(reserveCount.rows[0].value).toBe("1");
      const state=await pool.query<{status:string;seconds:string}>(`SELECT status,
        extract(epoch FROM (redemption_ends_at-redemption_starts_at))::text AS seconds
        FROM lp_vault_redemption_requests WHERE id=$1`,[requested[0].id]);
      expect(state.rows[0]).toEqual({status:"redeeming",seconds:"259200.000000"});
    });
  });

  it("rejects a reconciliation outside the UTC cutoff evidence window",async context=>{
    await withSchema(context,async(pool,client)=>{
      await seedVault(client); await seedReconciliation(client,new Date(utcCutoff().getTime()+5*60_000+1));
      await expireFirstCutoffBootstrapWindow(client);
      await expect(runDueLpVaultAccountingCycle({queryable:pool})).rejects.toThrow("lp_vault_due_cycle_source_unavailable");
    });
  });

  it("rejects fresh processing whose canonical block predates the UTC cutoff",async context=>{
    await withSchema(context,async(pool,client)=>{
      await seedVault(client);
      await expireFirstCutoffBootstrapWindow(client);
      const cutoff=utcCutoff();
      await seedReconciliation(client,new Date(cutoff.getTime()+60_000),100_000_000n,{
        chainEvidenceAt:new Date(cutoff.getTime()-1_000)
      });
      await expect(runDueLpVaultAccountingCycle({queryable:pool})).rejects.toThrow("lp_vault_due_cycle_source_unavailable");
    });
  });

  it("rejects reconciliation processing that predates its claimed canonical block",async context=>{
    await withSchema(context,async(pool,client)=>{
      await seedVault(client);
      await expireFirstCutoffBootstrapWindow(client);
      const cutoff=utcCutoff();
      const reconciliationId=await seedReconciliation(client,new Date(cutoff.getTime()+60_000),100_000_000n,{
        chainEvidenceAt:new Date(cutoff.getTime()+120_000)
      });
      await expect(runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,c=>
        inceptLpVaultAccounting(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,reconciliationId}),pool))
        .rejects.toThrow("lp_vault_accounting_inception_mismatch");
      await expect(runDueLpVaultAccountingCycle({queryable:pool})).rejects.toThrow("lp_vault_due_cycle_source_unavailable");
    });
  });

  it("fails closed on stale, mismatched, blocked, or legacy admission snapshots",async context=>{
    await withSchema(context,async(pool,client)=>{
      await seedVault(client);
      const cutoff=utcCutoff();
      await seedReconciliation(client,new Date(cutoff.getTime()+60_000),100_000_000n);
      await runDueLpVaultAccountingCycle({queryable:pool});
      const request=await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,c=>
        requestLpVaultRedemption(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,userId:INTERNAL_FOUNDER_LP_USER_ID,
          requestedShareUnits:1_000_000_000_000_000_000n,idempotencyKey:"invalid-admission-evidence"}),pool);
      await expect(admitWithFreshReconciliation(pool,{createdAt:new Date(Date.now()-6*60_000)}))
        .rejects.toThrow("lp_vault_redemption_admission_evidence_invalid");
      await expect(admitWithFreshReconciliation(pool,{chainEvidenceAt:new Date(Date.now()-6*60_000)}))
        .rejects.toThrow("lp_vault_redemption_admission_evidence_invalid");
      await expect(admitWithFreshReconciliation(pool,{scopeToken:`0x${"b".repeat(40)}`}))
        .rejects.toThrow("lp_vault_redemption_admission_evidence_invalid");
      await expect(admitWithFreshReconciliation(pool,{launchGate:"blocked",operationGate:"restricted"}))
        .rejects.toThrow("lp_vault_redemption_admission_evidence_invalid");
      await expect(admitWithFreshReconciliation(pool,{source:"legacy"}))
        .rejects.toThrow("lp_vault_redemption_admission_evidence_invalid");
      const valid=await admitWithFreshReconciliation(pool);
      expect(valid.result).toMatchObject({status:"redeeming",requestId:request.id});
    });
  });

  it("activates a post-cutoff deposit once at the next cycle's common pre-deposit price",async context=>{
    await withSchema(context,async(pool,client)=>{
      await seedVault(client);
      const inceptionCutoff=utcCutoff(-2); const earlyCutoff=utcCutoff(-1); const activationCutoff=utcCutoff();
      const inceptionReconciliation=await seedReconciliation(client,
        new Date(inceptionCutoff.getTime()+60_000),100_000_000n);
      await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,async c=>{
        await inceptLpVaultAccounting(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
          reconciliationId:inceptionReconciliation});
        const cycle=await openOrGetLpVaultCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
          cutoffDate:inceptionCutoff.toISOString().slice(0,10)});
        await closeLpVaultAccountingCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,cycleId:cycle.id,
          reconciliationId:inceptionReconciliation,sourceMaxAgeMs:300_000,ticketMarks:[]});
      },pool);
      const userId=randomUUID();
      await client.query("INSERT INTO users (id,email) VALUES ($1,$2)",[userId,`${userId}@example.test`]);
      const deposits=await Promise.all([3_000_000n,7_000_000n].map((amountMicroUnits,index)=>runLpVaultAccountingTransaction(
          FOUNDER_SEPOLIA_SHADOW_VAULT_ID,c=>recordPendingLpVaultDeposit(c,{
            vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,userId,amountMicroUnits,
            sourceReference:`test:post-cutoff-deposit:${index}`,idempotencyKey:`post-cutoff-deposit:${index}`}),pool)));
      expect(deposits.map(deposit=>deposit.eligible_after_cutoff))
        .toEqual(Array.from({length:2},()=>utcCutoff(1).toISOString().slice(0,10)));

      const earlyReconciliation=await seedReconciliation(client,new Date(earlyCutoff.getTime()+60_000),130_000_000n);
      await closeHistoricalCycle(pool,{cutoff:earlyCutoff,reconciliationId:earlyReconciliation});
      const early=await loadLatestVerifiedLpVaultAccounting(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,pool);
      expect(early).toMatchObject({economicNavMicroUnits:120_000_000n,
        activeShareUnits:100_000_000_000_000_000_000n,pendingActivationMicroUnits:10_000_000n});
      const earlyEvidence=await pool.query<{status:string;mints:string;positions:string;checkpoint_nav:string}>(`SELECT
        (SELECT status FROM lp_vault_pending_deposits WHERE id=$1) AS status,
        (SELECT count(*) FROM lp_vault_share_events WHERE pending_deposit_id=$1)::text AS mints,
        (SELECT count(*) FROM lp_vault_share_positions WHERE vault_id=$2 AND user_id=$3)::text AS positions,
        (SELECT net_asset_value_micro_units::text FROM lp_vault_nav_checkpoints checkpoints
          JOIN lp_vault_daily_cycles cycles ON cycles.id=checkpoints.cycle_id
          WHERE cycles.cutoff_date=$4::date) AS checkpoint_nav`,
      [deposits[0].id,FOUNDER_SEPOLIA_SHADOW_VAULT_ID,userId,earlyCutoff.toISOString().slice(0,10)]);
      expect(earlyEvidence.rows[0]).toEqual({status:"pending",mints:"0",positions:"0",checkpoint_nav:"120000000"});

      for(const [index,deposit] of deposits.entries()){
        await backdatePendingDepositForTest(client,{depositId:deposit.id,
          createdAt:new Date(earlyCutoff.getTime()+120_000+index),eligibleAfterCutoff:activationCutoff});
      }
      const activationReconciliation=await seedReconciliation(client,
        new Date(activationCutoff.getTime()+60_000),130_000_000n);
      const closeActivation=()=>closeHistoricalCycle(pool,{cutoff:activationCutoff,
        reconciliationId:activationReconciliation});
      const results=await Promise.all(Array.from({length:12},closeActivation));
      expect(new Set(results.map(result=>result.cycleId)).size).toBe(1);
      const expectedMint=10_000_000n*100_000_000_000_000_000_000n/120_000_000n;
      const activated=await pool.query<{active:string;mints:string;activation_events:string;share_units:string;
        checkpoint_nav:string;checkpoint_supply:string}>(`SELECT
        count(*) FILTER (WHERE deposits.status='active')::text AS active,
        count(events.id)::text AS mints,
        count(accounting.id)::text AS activation_events,
        sum(events.share_units)::text AS share_units,
        min(checkpoints.net_asset_value_micro_units)::text AS checkpoint_nav,
        min(checkpoints.share_supply_units)::text AS checkpoint_supply
        FROM lp_vault_pending_deposits deposits
        JOIN lp_vault_share_events events ON events.pending_deposit_id=deposits.id
        JOIN lp_vault_accounting_events accounting ON accounting.event_type='deposit_activated'
          AND accounting.payload->>'depositId'=deposits.id::text
        JOIN lp_vault_nav_checkpoints checkpoints ON checkpoints.id=deposits.activation_checkpoint_id
        WHERE deposits.id=ANY($1::uuid[])`,[deposits.map(deposit=>deposit.id)]);
      expect(activated.rows[0]).toEqual({active:"2",mints:"2",activation_events:"2",
        share_units:expectedMint.toString(),checkpoint_nav:"120000000",checkpoint_supply:"100000000000000000000"});
      expect(expectedMint).not.toBe(10_000_000_000_000_000_000n);
      const latest=await loadLatestVerifiedLpVaultAccounting(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,pool);
      expect(latest).toMatchObject({economicNavMicroUnits:130_000_000n,
        activeShareUnits:100_000_000_000_000_000_000n+expectedMint,pendingActivationMicroUnits:0n});
      await closeActivation();
      expect((await pool.query<{mints:string;events:string}>(`SELECT
        (SELECT count(*) FROM lp_vault_share_events WHERE pending_deposit_id=ANY($1::uuid[]))::text AS mints,
        (SELECT count(*) FROM lp_vault_accounting_events WHERE event_type='deposit_activated'
          AND payload->>'depositId'=ANY($1::text[]))::text AS events`,[deposits.map(deposit=>deposit.id)])).rows[0])
        .toEqual({mints:"2",events:"2"});
      await assertExactCycleConservation(pool,3);
    });
  });

  it("moves an authoritative settlement from estimated liability to finalized P&L exactly once",async context=>{
    await withSchema(context,async(pool,client)=>{
      await seedVault(client);
      const inceptionCutoff=utcCutoff(-2); const unresolvedCutoff=utcCutoff(-1); const settledCutoff=utcCutoff();
      const inceptionReconciliation=await seedReconciliation(client,new Date(inceptionCutoff.getTime()+60_000),100_000_000n);
      await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,async c=>{
        await inceptLpVaultAccounting(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,reconciliationId:inceptionReconciliation});
        const cycle=await openOrGetLpVaultCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
          cutoffDate:inceptionCutoff.toISOString().slice(0,10)});
        await closeLpVaultAccountingCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,cycleId:cycle.id,
          reconciliationId:inceptionReconciliation,sourceMaxAgeMs:300_000,ticketMarks:[]});
      },pool);
      const ticket=await seedHouseBookTicketReserve(client,new Date(inceptionCutoff.getTime()+120_000));
      const unresolvedReconciliation=await seedReconciliation(client,new Date(unresolvedCutoff.getTime()+60_000),101_000_000n);
      await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,async c=>{
        const cycle=await openOrGetLpVaultCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
          cutoffDate:unresolvedCutoff.toISOString().slice(0,10)});
        await closeLpVaultAccountingCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,cycleId:cycle.id,
          reconciliationId:unresolvedReconciliation,sourceMaxAgeMs:300_000,ticketMarks:[{ticketId:ticket.ticket,
            markedLiabilityMicroUnits:2_000_000n,markSource:"gross_payout_fallback",
            fallbackReason:"no reliable fixture mark",evidenceTime:new Date(unresolvedCutoff.getTime()+60_000)}]});
      },pool);
      const unresolved=await loadLatestVerifiedLpVaultAccounting(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,pool);
      expect(unresolved).toMatchObject({economicNavMicroUnits:99_000_000n,estimatedPnlMicroUnits:-1_000_000n,
        finalizedPnlMicroUnits:0n,markedUnresolvedLiabilityMicroUnits:2_000_000n});
      const summaryId=await settleHouseBookTicketAsLost(client,ticket,new Date(unresolvedCutoff.getTime()+120_000));
      const settledReconciliation=await seedReconciliation(client,new Date(settledCutoff.getTime()+60_000),101_000_000n);
      const closeSettled=()=>runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,async c=>{
        const cycle=await openOrGetLpVaultCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
          cutoffDate:settledCutoff.toISOString().slice(0,10)});
        return await closeLpVaultAccountingCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,cycleId:cycle.id,
          reconciliationId:settledReconciliation,sourceMaxAgeMs:300_000,ticketMarks:[]});
      },pool);
      const [left,right]=await Promise.all([closeSettled(),closeSettled()]);
      expect(left.cycleId).toBe(right.cycleId);
      const latest=await loadLatestVerifiedLpVaultAccounting(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,pool);
      expect(latest).toMatchObject({economicNavMicroUnits:101_000_000n,estimatedPnlMicroUnits:0n,
        finalizedPnlMicroUnits:1_000_000n,markedUnresolvedLiabilityMicroUnits:0n});
      const recognition=await pool.query<{recognitions:string;events:string;cycle_count:string}>(`SELECT
        (SELECT count(*) FROM lp_vault_settlement_recognitions WHERE settlement_summary_id=$1)::text AS recognitions,
        (SELECT count(*) FROM lp_vault_accounting_events WHERE event_type='settlement_recognized'
          AND payload->>'settlementSummaryId'=$1::text)::text AS events,
        (SELECT count(DISTINCT cycle_id) FROM lp_vault_settlement_recognitions WHERE settlement_summary_id=$1)::text AS cycle_count`,
      [summaryId]);
      expect(recognition.rows[0]).toEqual({recognitions:"1",events:"1",cycle_count:"1"});
      const restarted=await runDueLpVaultAccountingCycle({queryable:pool});
      expect(restarted.status).toBe("already_closed");
      expect((await pool.query<{value:string}>("SELECT count(*)::text AS value FROM lp_vault_settlement_recognitions WHERE settlement_summary_id=$1",
        [summaryId])).rows[0].value).toBe("1");
      await assertExactCycleConservation(pool,3);
      const markConstraint=await pool.query<{definition:string}>(`SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid='lp_vault_ticket_liability_marks'::regclass
          AND pg_get_constraintdef(oid) LIKE '%mark_source%'`);
      expect(markConstraint.rows.some(row=>row.definition.includes("mark_source = 'gross_payout_fallback'"))).toBe(true);
      await expect(runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,async c=>{
        const nextCycle=await openOrGetLpVaultCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
          cutoffDate:utcCutoff(1).toISOString().slice(0,10)});
        const markId=randomUUID();
        const event=await appendLpVaultAccountingEvent(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
          eventType:"ticket_liability_marked",entityId:markId,payload:{ticketId:ticket.ticket}});
        await c.query(`INSERT INTO lp_vault_ticket_liability_marks (
          id,vault_id,cycle_id,ticket_id,stake_micro_units,gross_payout_micro_units,marked_liability_micro_units,
          mark_source,fallback_reason,evidence_time,accounting_event_id)
          VALUES ($1,$2,$3,$4,1000000,2000000,1000000,'reliable_mark','unproven',now(),$5)`,
        [markId,FOUNDER_SEPOLIA_SHADOW_VAULT_ID,nextCycle.id,ticket.ticket,event.id]);
      },pool)).rejects.toThrow();
    });
  });

  it("recognizes a post-inception settlement for a ticket that was already live at inception",async context=>{
    await withSchema(context,async(pool,client)=>{
      await seedVault(client);
      const inceptionCutoff=utcCutoff(-1); const settledCutoff=utcCutoff();
      const historicalTicket=await seedHouseBookTicketReserve(client,new Date(inceptionCutoff.getTime()-180_000));
      const historicalSummaryId=await settleHouseBookTicketAsLost(client,historicalTicket,
        new Date(inceptionCutoff.getTime()-120_000));
      const ticket=await seedHouseBookTicketReserve(client,new Date(inceptionCutoff.getTime()-60_000));
      const inceptionReconciliation=await seedReconciliation(client,
        new Date(inceptionCutoff.getTime()+60_000),101_000_000n,{
          openStakeMicroUnits:1_000_000n,
          openReserveMicroUnits:1_000_000n
        });
      await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,async c=>{
        await inceptLpVaultAccounting(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
          reconciliationId:inceptionReconciliation});
        const cycle=await openOrGetLpVaultCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
          cutoffDate:inceptionCutoff.toISOString().slice(0,10)});
        await closeLpVaultAccountingCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,cycleId:cycle.id,
          reconciliationId:inceptionReconciliation,sourceMaxAgeMs:300_000,ticketMarks:[{
            ticketId:ticket.ticket,markedLiabilityMicroUnits:2_000_000n,markSource:"gross_payout_fallback",
            fallbackReason:"pre-inception live ticket",evidenceTime:new Date(inceptionCutoff.getTime()+60_000)
          }]});
      },pool);
      expect(await loadLatestVerifiedLpVaultAccounting(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,pool)).toMatchObject({
        estimatedPnlMicroUnits:-1_000_000n,
        finalizedPnlMicroUnits:0n,
        markedUnresolvedLiabilityMicroUnits:2_000_000n
      });
      const summaryId=await settleHouseBookTicketAsLost(client,ticket,new Date(inceptionCutoff.getTime()+120_000));
      const settledReconciliation=await seedReconciliation(client,new Date(settledCutoff.getTime()+60_000),101_000_000n);
      await closeHistoricalCycle(pool,{cutoff:settledCutoff,reconciliationId:settledReconciliation});
      expect(await loadLatestVerifiedLpVaultAccounting(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,pool)).toMatchObject({
        estimatedPnlMicroUnits:0n,
        finalizedPnlMicroUnits:1_000_000n,
        markedUnresolvedLiabilityMicroUnits:0n
      });
      expect((await pool.query<{count:string}>(`SELECT count(*)::text AS count
        FROM lp_vault_settlement_recognitions WHERE settlement_summary_id=$1`,[summaryId])).rows[0].count).toBe("1");
      expect((await pool.query<{count:string}>(`SELECT count(*)::text AS count
        FROM lp_vault_settlement_recognitions WHERE settlement_summary_id=$1`,[historicalSummaryId])).rows[0].count).toBe("0");
      await assertExactCycleConservation(pool,2);
    });
  });

  it("admits only the FIFO head from fresh reconciliation evidence and fails closed on liquidity",async context=>{
    await withSchema(context,async(pool,client)=>{
      await seedVault(client);
      const inceptionCutoff=utcCutoff(-1); const activationCutoff=utcCutoff();
      const inceptionReconciliation=await seedReconciliation(client,
        new Date(inceptionCutoff.getTime()+60_000),100_000_000n);
      await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,async c=>{
        await inceptLpVaultAccounting(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
          reconciliationId:inceptionReconciliation});
        const cycle=await openOrGetLpVaultCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
          cutoffDate:inceptionCutoff.toISOString().slice(0,10)});
        await closeLpVaultAccountingCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,cycleId:cycle.id,
          reconciliationId:inceptionReconciliation,sourceMaxAgeMs:300_000,ticketMarks:[]});
      },pool);
      const userIds=[randomUUID(),randomUUID()];
      for(const userId of userIds){
        await client.query("INSERT INTO users (id,email) VALUES ($1,$2)",[userId,`${userId}@example.test`]);
      }
      for(const [index,userId] of userIds.entries()){
        const deposit=await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,c=>
          recordPendingLpVaultDeposit(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,userId,
            amountMicroUnits:10_000_000n,sourceReference:`test:reserve-liquidity:${index}`,
            idempotencyKey:`reserve-liquidity:${index}`}),pool);
        await backdatePendingDepositForTest(client,{depositId:deposit.id,
          createdAt:new Date(inceptionCutoff.getTime()+120_000+index),eligibleAfterCutoff:activationCutoff});
      }
      const reconciliationTime=new Date(activationCutoff.getTime()+60_000);
      const activationReconciliation=await seedReconciliation(client,reconciliationTime,120_000_000n);
      await closeHistoricalCycle(pool,{cutoff:activationCutoff,reconciliationId:activationReconciliation});
      const positions=await pool.query<{user_id:string;balance:string}>(`SELECT positions.user_id,
        sum(CASE WHEN events.event_type='mint' THEN events.share_units ELSE -events.share_units END)::text AS balance
        FROM lp_vault_share_positions positions JOIN lp_vault_share_events events ON events.position_id=positions.id
        WHERE positions.vault_id=$1 GROUP BY positions.user_id`,[FOUNDER_SEPOLIA_SHADOW_VAULT_ID]);
      const balanceFor=(userId:string)=>BigInt(positions.rows.find(row=>row.user_id===userId)!.balance);
      expect(balanceFor(userIds[0])).toBe(10_000_000_000_000_000_000n);
      expect(balanceFor(userIds[1])).toBe(10_000_000_000_000_000_000n);
      const first=await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,c=>
        requestLpVaultRedemption(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,userId:userIds[0],
          requestedShareUnits:10_000_000_000_000_000_000n,idempotencyKey:"reserve-first"}),pool);
      const second=await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,c=>
        requestLpVaultRedemption(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,userId:userIds[1],
          requestedShareUnits:10_000_000_000_000_000_000n,idempotencyKey:"reserve-second"}),pool);

      const oldEvidenceClient=await pool.connect();
      try{
        await oldEvidenceClient.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await lockFinancialControlGateForMutation(oldEvidenceClient);
        await oldEvidenceClient.query("SELECT set_config('legwork.financial_global_exclusive_lock', 'held', true)");
        await expect(admitNextLpVaultRedemption(oldEvidenceClient,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
          reconciliationSnapshotId:activationReconciliation})).rejects.toThrow("lp_vault_redemption_admission_evidence_invalid");
        await oldEvidenceClient.query("ROLLBACK");
      }finally{oldEvidenceClient.release();}

      const directReserve=(requestId:string,label:string,assets:bigint)=>async()=>{
        const c=await pool.connect();
        try{
          await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
          await lockFinancialControlGateForMutation(c);
          await c.query("SELECT set_config('legwork.financial_global_exclusive_lock', 'held', true)");
          const transactionNow=(await c.query<{now:Date}>("SELECT now() AS now")).rows[0].now;
          const reconciliationSnapshotId=await seedReconciliation(c,transactionNow,assets,{
            metrics:await currentAdmissionMetrics(c)
          });
          await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[
            `lp-vault-accounting:${FOUNDER_SEPOLIA_SHADOW_VAULT_ID}`
          ]);
          const evidence=await c.query<{cycle_id:string;checkpoint_id:string;required:string;available:string}>(`SELECT
              cycles.id AS cycle_id,checkpoints.id AS checkpoint_id,capacity.required_liquidity_micro_units::text AS required,
              capacity.available_liquidity_before_micro_units::text AS available
            FROM lp_vault_daily_cycles cycles
            JOIN lp_vault_nav_checkpoints checkpoints ON checkpoints.cycle_id=cycles.id
            CROSS JOIN LATERAL calculate_lp_vault_redemption_admission_capacity($1,$2,cycles.id,checkpoints.id,$3) capacity
            WHERE cycles.vault_id=$1 AND cycles.status='closed' ORDER BY cycles.cutoff_date DESC LIMIT 1`,
          [FOUNDER_SEPOLIA_SHADOW_VAULT_ID,reconciliationSnapshotId,requestId]);
          const reserveId=randomUUID();
          const event=await appendLpVaultAccountingEvent(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
            eventType:"redemption_admitted",entityId:reserveId,payload:{requestId,label,
              reservedShareUnits:"10000000000000000000",reconciliationSnapshotId,
              accountingCycleId:evidence.rows[0].cycle_id,accountingCheckpointId:evidence.rows[0].checkpoint_id,
              requiredLiquidityMicroUnits:evidence.rows[0].required,
              availableLiquidityBeforeMicroUnits:evidence.rows[0].available}});
          await c.query(`INSERT INTO lp_vault_redemption_reserves (
            id,vault_id,redemption_request_id,reserved_share_units,admission_reconciliation_snapshot_id,
            admission_accounting_cycle_id,admission_checkpoint_id,required_liquidity_micro_units,
            available_liquidity_before_micro_units,accounting_event_id)
            VALUES ($1,$2,$3,10000000000000000000,$4,$5,$6,$7,$8,$9)`,
          [reserveId,FOUNDER_SEPOLIA_SHADOW_VAULT_ID,requestId,reconciliationSnapshotId,evidence.rows[0].cycle_id,
            evidence.rows[0].checkpoint_id,evidence.rows[0].required,evidence.rows[0].available,event.id]);
          await c.query("COMMIT");
        }catch(error){await c.query("ROLLBACK").catch(()=>undefined);throw error;}finally{c.release();}
      };

      await expect(directReserve(second.id,"fifo-bypass",120_000_000n)())
        .rejects.toThrow("lp_vault_redemption_reserve_mismatch");
      const admitted=await admitWithFreshReconciliation(pool,{assets:120_000_000n});
      expect(admitted.result).toMatchObject({status:"redeeming",requestId:first.id,
        requiredLiquidityMicroUnits:10_000_000n,availableLiquidityBeforeMicroUnits:120_000_000n});
      const waiting=await admitWithFreshReconciliation(pool,{assets:15_000_000n});
      expect(waiting.result).toMatchObject({status:"waiting_liquidity",requestId:second.id,
        requiredLiquidityMicroUnits:10_000_000n,availableLiquidityBeforeMicroUnits:5_000_000n});
      await expect(directReserve(second.id,"liquidity-bypass",15_000_000n)())
        .rejects.toThrow("lp_vault_redemption_reserve_mismatch");
      const evidence=await pool.query<{reserves:string;second_status:string}>(`SELECT
        (SELECT count(*) FROM lp_vault_redemption_reserves WHERE vault_id=$1)::text AS reserves,
        (SELECT status FROM lp_vault_redemption_requests WHERE id=$2) AS second_status`,
      [FOUNDER_SEPOLIA_SHADOW_VAULT_ID,second.id]);
      expect(evidence.rows[0]).toEqual({reserves:"1",second_status:"waiting_liquidity"});
      await expect(replayLpVaultAccounting(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,pool)).resolves.toMatchObject({
        checkpointCount:2
      });
    });
  });

  it("calculates exact redemption admission capacity across live, soft, pending, fee, expense, and reserve components",async context=>{
    await withSchema(context,async(pool,client)=>{
      await seedVault(client);
      const inceptionCutoff=utcCutoff(-1); const activationCutoff=utcCutoff();
      const inceptionReconciliation=await seedReconciliation(client,
        new Date(inceptionCutoff.getTime()+60_000),100_000_000n);
      await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,async c=>{
        await inceptLpVaultAccounting(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
          reconciliationId:inceptionReconciliation});
        const cycle=await openOrGetLpVaultCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
          cutoffDate:inceptionCutoff.toISOString().slice(0,10)});
        await closeLpVaultAccountingCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,cycleId:cycle.id,
          reconciliationId:inceptionReconciliation,sourceMaxAgeMs:300_000,ticketMarks:[]});
      },pool);

      const redemptionUsers=[randomUUID(),randomUUID()];
      const pendingUser=randomUUID();
      for(const userId of [...redemptionUsers,pendingUser]){
        await client.query("INSERT INTO users (id,email) VALUES ($1,$2)",[userId,`${userId}@example.test`]);
      }
      for(const [index,userId] of redemptionUsers.entries()){
        const deposit=await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,c=>
          recordPendingLpVaultDeposit(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,userId,
            amountMicroUnits:10_000_000n,sourceReference:`capacity-active:${index}`,
            idempotencyKey:`capacity-active:${index}`}),pool);
        await backdatePendingDepositForTest(client,{depositId:deposit.id,
          createdAt:new Date(inceptionCutoff.getTime()+120_000+index),eligibleAfterCutoff:activationCutoff});
      }
      const activationReconciliation=await seedReconciliation(client,
        new Date(activationCutoff.getTime()+60_000),120_000_003n);
      await closeHistoricalCycle(pool,{cutoff:activationCutoff,reconciliationId:activationReconciliation});

      const positions=await pool.query<{user_id:string;id:string}>(`SELECT user_id,id FROM lp_vault_share_positions
        WHERE vault_id=$1 AND user_id=ANY($2::uuid[])`,[FOUNDER_SEPOLIA_SHADOW_VAULT_ID,redemptionUsers]);
      expect(positions.rows).toHaveLength(2);
      const firstRequest=await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,c=>
        requestLpVaultRedemption(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,userId:redemptionUsers[0],
          requestedShareUnits:1_000_000_000_000_000_000n,idempotencyKey:"capacity-first"}),pool);
      const secondRequest=await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,c=>
        requestLpVaultRedemption(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,userId:redemptionUsers[1],
          requestedShareUnits:1_000_000_000_000_000_000n,idempotencyKey:"capacity-second"}),pool);

      const fixtureTime=new Date(Date.now()-1_000);
      const highPayout=await seedHouseBookTicketReserve(client,fixtureTime,{
        stakeMicroUnits:1_000_000n,offeredPayoutMicroUnits:1_000_001n,operationFeeMicroUnits:17n
      });
      await seedHouseBookTicketReserve(client,fixtureTime,{
        stakeMicroUnits:1n,offeredPayoutMicroUnits:2n
      });
      await seedSoftExposureReservation(client,{userId:highPayout.user,policyId:highPayout.policy,
        stakeMicroUnits:1_000_000n,offeredPayoutMicroUnits:1_000_001n});
      await seedSoftExposureReservation(client,{userId:highPayout.user,policyId:highPayout.policy,
        stakeMicroUnits:1n,offeredPayoutMicroUnits:2n});
      await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,async c=>
        recognizeLpVaultFeesAndSettlements(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
          cycleId:(await c.query<{id:string}>(`SELECT id FROM lp_vault_daily_cycles WHERE vault_id=$1
            ORDER BY cutoff_date DESC LIMIT 1`,[FOUNDER_SEPOLIA_SHADOW_VAULT_ID])).rows[0].id,
          sourceThrough:new Date()}),pool);
      await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,async c=>{
        const expenseId=randomUUID();
        const event=await appendLpVaultAccountingEvent(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
          eventType:"expense_accrued",entityId:expenseId,payload:{amountMicroUnits:"31",approvalReference:"capacity-expense"}});
        await c.query(`INSERT INTO lp_vault_approved_expense_accruals (
          id,vault_id,amount_micro_units,accrued_on,approval_reference,evidence,accounting_event_id
        ) VALUES ($1,$2,31,current_date,'capacity-expense',$3::jsonb,$4)`,
        [expenseId,FOUNDER_SEPOLIA_SHADOW_VAULT_ID,JSON.stringify({source:"test"}),event.id]);
      },pool);
      await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,c=>
        recordPendingLpVaultDeposit(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,userId:pendingUser,
          amountMicroUnits:100_003n,sourceReference:"capacity-pending",idempotencyKey:"capacity-pending"}),pool);

      const firstAdmission=await admitWithFreshReconciliation(pool,{assets:10_000_000n});
      expect(firstAdmission.result).toMatchObject({status:"redeeming",requestId:firstRequest.id,
        requiredLiquidityMicroUnits:1_000_001n});

      const capacityClient=await pool.connect();
      try{
        await capacityClient.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await lockFinancialControlGateForMutation(capacityClient);
        await capacityClient.query("SELECT set_config('legwork.financial_global_exclusive_lock', 'held', true)");
        const now=(await capacityClient.query<{now:Date}>("SELECT now() AS now")).rows[0].now;
        const reconciliationId=await seedReconciliation(capacityClient,now,10_000_000n,{
          metrics:await currentAdmissionMetrics(capacityClient)
        });
        const capacity=await capacityClient.query<{required:string;available:string}>(`SELECT
          required_liquidity_micro_units::text AS required,
          available_liquidity_before_micro_units::text AS available
          FROM lp_vault_daily_cycles cycles
          JOIN lp_vault_nav_checkpoints checkpoints ON checkpoints.cycle_id=cycles.id
          CROSS JOIN LATERAL calculate_lp_vault_redemption_admission_capacity($1,$2,cycles.id,checkpoints.id,$3)
          WHERE cycles.vault_id=$1 AND cycles.status='closed' ORDER BY cycles.cutoff_date DESC LIMIT 1`,
        [FOUNDER_SEPOLIA_SHADOW_VAULT_ID,reconciliationId,secondRequest.id]);
        const components=await capacityClient.query<{
          gross:string;soft:string;pending:string;fees:string;expenses:string;active_reserve:string;
        }>(`SELECT
          (SELECT sum(offered_payout_micro_units)::text FROM ticket_reserves WHERE status='reserved') AS gross,
          (SELECT sum(GREATEST(ceil(quotes.offered_payout_micro_usd::numeric*125/100)::bigint-
            quotes.stake_micro_usd,0))::text FROM quote_payment_exposure_reservations reservations
            JOIN quotes ON quotes.id=reservations.quote_id WHERE reservations.status='reserved'
              AND reservations.expires_at>now()) AS soft,
          (SELECT sum(amount_micro_units)::text FROM lp_vault_pending_deposits WHERE vault_id=$1 AND status='pending') AS pending,
          (SELECT sum(amount_micro_units)::text FROM lp_vault_protocol_fee_events WHERE vault_id=$1 AND event_type='accrual') AS fees,
          (SELECT sum(amount_micro_units)::text FROM lp_vault_approved_expense_accruals WHERE vault_id=$1) AS expenses,
          (SELECT sum(ceil(reserves.reserved_share_units*closing.closing_economic_nav_micro_units::numeric /
            closing.closing_share_supply_units))::text FROM lp_vault_redemption_reserves reserves
            JOIN lp_vault_redemption_requests requests ON requests.id=reserves.redemption_request_id
            JOIN lp_vault_cycle_closing_states closing ON closing.cycle_id=reserves.admission_accounting_cycle_id
            WHERE reserves.vault_id=$1 AND requests.status IN ('admitted','redeeming')) AS active_reserve`,
        [FOUNDER_SEPOLIA_SHADOW_VAULT_ID]);
        expect(components.rows[0]).toEqual({gross:"1000003",soft:"250004",pending:"100003",fees:"17",
          expenses:"31",active_reserve:"1000001"});
        expect(capacity.rows[0]).toEqual({required:"1000001",available:"7399940"});
        await capacityClient.query("COMMIT");
      }catch(error){
        await capacityClient.query("ROLLBACK").catch(()=>undefined);
        throw error;
      }finally{capacityClient.release();}
    });
  });

  it("closes a second cycle with one concurrent redemption finalization",async context=>{
    await withSchema(context,async(pool,client)=>{
      await seedVault(client);
      const priorCutoff=utcCutoff(-1); const currentCutoff=utcCutoff();
      const priorReconciliation=await seedReconciliation(client,new Date(priorCutoff.getTime()+60_000),100_000_000n);
      await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,async c=>{
        await inceptLpVaultAccounting(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,reconciliationId:priorReconciliation});
        const cycle=await openOrGetLpVaultCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
          cutoffDate:priorCutoff.toISOString().slice(0,10)});
        await closeLpVaultAccountingCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,cycleId:cycle.id,
          reconciliationId:priorReconciliation,sourceMaxAgeMs:300_000,ticketMarks:[]});
      },pool);
      const redemption=await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,c=>
        requestLpVaultRedemption(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,userId:INTERNAL_FOUNDER_LP_USER_ID,
          requestedShareUnits:1_000_000_000_000_000_000n,idempotencyKey:"mature-next-cycle"}),pool);
      expect((await admitWithFreshReconciliation(pool)).result.status).toBe("redeeming");
      await backdateRedemptionWindowForTest(client,{redemptionRequestId:redemption.id,
        redemptionEndsAt:new Date(currentCutoff.getTime()-60_000)});
      const currentReconciliation=await seedReconciliation(client,new Date(currentCutoff.getTime()+60_000),100_000_000n);
      const runClose=()=>runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,async c=>{
        const cycle=await openOrGetLpVaultCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
          cutoffDate:currentCutoff.toISOString().slice(0,10)});
        return await closeLpVaultAccountingCycle(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,cycleId:cycle.id,
          reconciliationId:currentReconciliation,sourceMaxAgeMs:300_000,ticketMarks:[]});
      },pool);
      const [left,right]=await Promise.all([runClose(),runClose()]);
      expect(left.cycleId).toBe(right.cycleId);
      const latest=await loadLatestVerifiedLpVaultAccounting(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,pool);
      expect(latest?.economicNavMicroUnits).toBe(99_000_000n);
      expect(latest?.activeShareUnits).toBe(99_000_000_000_000_000_000n);
      expect(latest?.activeRedemptionReserveMicroUnits).toBe(0n);
      expect(latest?.collateralRequirementsMicroUnits).toBe(1_000_000n);
      expect(latest?.freeLiquidityMicroUnits).toBe(99_000_000n);
      const evidence=await pool.query<{burns:string;payables:string;finalized_events:string;claimable_events:string;
        checkpoint_nav:string;checkpoint_active_reserve:string;status:string}>(`SELECT
        (SELECT count(*) FROM lp_vault_share_events WHERE event_type='burn')::text AS burns,
        (SELECT count(*) FROM lp_vault_redemption_payables)::text AS payables,
        (SELECT count(*) FROM lp_vault_accounting_events WHERE event_type='redemption_finalized')::text AS finalized_events,
        (SELECT count(*) FROM lp_vault_accounting_events WHERE event_type='redemption_claimable')::text AS claimable_events,
        (SELECT checkpoints.net_asset_value_micro_units FROM lp_vault_nav_checkpoints checkpoints
          JOIN lp_vault_daily_cycles cycles ON cycles.id=checkpoints.cycle_id
          WHERE cycles.cutoff_date=$1::date)::text AS checkpoint_nav,
        (SELECT liquidity.active_redemption_reserve_micro_units FROM lp_vault_liquidity_marks liquidity
          JOIN lp_vault_daily_cycles cycles ON cycles.id=liquidity.cycle_id
          WHERE cycles.cutoff_date=$1::date)::text AS checkpoint_active_reserve,
        (SELECT status FROM lp_vault_redemption_requests WHERE id=$2) AS status`,
      [currentCutoff.toISOString().slice(0,10),redemption.id]);
      expect(evidence.rows[0]).toEqual({burns:"1",payables:"1",finalized_events:"1",claimable_events:"1",
        checkpoint_nav:"100000000",checkpoint_active_reserve:"1000000",status:"claimable"});
      const replay=await replayLpVaultAccounting(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,pool);
      expect(replay.checkpointCount).toBe(2); expect(replay.replayedShareSupplyUnits).toBe(latest?.activeShareUnits);
      const restarted=await runDueLpVaultAccountingCycle({queryable:pool});
      expect(restarted.status).toBe("already_closed");
      const subsequent=await runLpVaultAccountingTransaction(FOUNDER_SEPOLIA_SHADOW_VAULT_ID,c=>
        requestLpVaultRedemption(c,{vaultId:FOUNDER_SEPOLIA_SHADOW_VAULT_ID,userId:INTERNAL_FOUNDER_LP_USER_ID,
          requestedShareUnits:99_000_000_000_000_000_000n,idempotencyKey:"after-finalized-reserve"}),pool);
      expect(subsequent.status).toBe("queued");
      expect((await pool.query<{historical:string;remaining:string}>(`SELECT
        (SELECT count(*) FROM lp_vault_redemption_reserves reserves
          JOIN lp_vault_redemption_requests requests ON requests.id=reserves.redemption_request_id
          WHERE requests.status='claimable')::text AS historical,
        (SELECT sum(CASE WHEN event_type='mint' THEN share_units ELSE -share_units END)::text
          FROM lp_vault_share_events events JOIN lp_vault_share_positions positions ON positions.id=events.position_id
          WHERE positions.vault_id=$1 AND positions.user_id=$2) AS remaining`,
      [FOUNDER_SEPOLIA_SHADOW_VAULT_ID,INTERNAL_FOUNDER_LP_USER_ID])).rows[0])
        .toEqual({historical:"1",remaining:"99000000000000000000"});
      await expect(pool.query("UPDATE lp_vault_cycle_closing_states SET closing_economic_nav_micro_units=0"))
        .rejects.toThrow("lp_vault_cycle_closing_states_is_append_only");
    });
  });
});

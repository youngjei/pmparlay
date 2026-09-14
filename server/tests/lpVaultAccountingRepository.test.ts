import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  acquireLpVaultAccountingAdvisoryLock,
  admitNextLpVaultRedemption,
  allocateOwnerMintAcrossDeposits,
  appendLpVaultAccountingEvent,
  assertSupportedLpVaultLiabilityMarkSource,
  finalizeEligibleLpVaultRedemptions,
  loadVerifiedLpVaultOwnerAccounting,
  loadUnresolvedLpVaultTicketsAsOf,
  markActiveLpVaultRedemptionReserves,
  replayLpVaultAccounting,
  runLpVaultAccountingTransaction
} from "../db/lpVaultAccountingRepository";

const vaultId="00000000-0000-4000-8000-000000000001";
const userId="00000000-0000-4000-8000-000000000002";

function hash(value:string){return `sha256:${createHash("sha256").update(value).digest("hex")}`;}

function eventRows(inputs:Array<{eventType:string;entityId:string;payload:Record<string,unknown>}>){
  let previous:string|null=null;
  return inputs.map((input,index)=>{
    const payloadText=JSON.stringify(input.payload);
    const payloadHash=hash(payloadText);
    const version=String(index+1);
    const eventHash=hash(`${vaultId}:${version}:${previous??""}:${input.eventType}:${input.entityId}:${payloadHash}`);
    const row={id:`00000000-0000-4000-9000-${String(index+1).padStart(12,"0")}`,vault_id:vaultId,
      book_version:version,event_type:input.eventType,entity_id:input.entityId,payload:input.payload,payload_text:payloadText,
      payload_hash:payloadHash,previous_event_hash:previous,event_hash:eventHash,recorded_at:new Date("2026-09-10T00:04:00Z")};
    previous=eventHash;
    return row;
  });
}

const checkpointId="00000000-0000-4000-8000-000000000010";
const closingId="00000000-0000-4000-8000-000000000011";
const replayEvents=eventRows([
  {eventType:"liability_marked",entityId:"00000000-0000-4000-8000-000000000009",
    payload:{grossAssetsMicroUnits:"100000000",navDeductionsMicroUnits:"100000000"}},
  {eventType:"nav_checkpointed",entityId:checkpointId,
    payload:{grossAssetsMicroUnits:"100000000",navDeductionsMicroUnits:"100000000",
      economicNavMicroUnits:"0",shareSupplyUnits:"0"}},
  {eventType:"deposit_activated",entityId:"00000000-0000-4000-8000-000000000012",
    payload:{shareUnits:"100000000000000000000",amountMicroUnits:"100000000"}},
  {eventType:"cycle_closed",entityId:closingId,payload:{checkpointId,activatedDepositMicroUnits:"100000000",
    maturedRedemptionMicroUnits:"0",protocolRoundingDustMicroUnits:"0",closingEconomicNavMicroUnits:"100000000",
    closingShareSupplyUnits:"100000000000000000000"}},
  {eventType:"deposit_pending",entityId:"00000000-0000-4000-8000-000000000013",
    payload:{userId,amountMicroUnits:"5000000"}}
]);

function replayProjection(overrides:Record<string,string|null>={}){
  return {checkpoint_count:"1",share_event_count:"1",minted:"100000000000000000000",burned:"0",
    supply:"100000000000000000000",closed_cycle_count:"1",closing_state_count:"1",closing_id:closingId,
    closing_event_version:"4",checkpoint_id:checkpointId,closing_nav:"100000000",
    closing_supply:"100000000000000000000",checkpoint_gross:"100000000",checkpoint_nav:"0",
    checkpoint_supply:"0",checkpoint_deductions:"100000000",activated:"100000000",matured:"0",dust:"0",...overrides};
}

function shareProjection(projectionMatches=true){
  return {accounting_event_id:replayEvents[2].id,projection_matches:projectionMatches};
}

function readOnlyPool(query:ReturnType<typeof vi.fn>){
  const client={
    query:vi.fn((sql:string,args?:unknown[])=>{
      if(sql.startsWith("BEGIN")||sql==="COMMIT"||sql==="ROLLBACK") return Promise.resolve({rows:[]});
      return query(sql,args);
    }),
    release:vi.fn()
  };
  return {pool:{connect:vi.fn(async()=>client)},client};
}

function latestAccountingRow(asOf:Date){
  return {vault_id:vaultId,cycle_id:"00000000-0000-4000-8000-000000000020",cutoff_date:"2026-09-10",as_of:asOf,
    processed_at:new Date(asOf.getTime()+1000),
    reconciliation_id:"00000000-0000-4000-8000-000000000021",book_version:"4",canonical_block_number:"123",
    canonical_block_hash:`0x${"a".repeat(64)}`,gross_assets:"100000000",nav:"100000000",
    supply:"100000000000000000000",price_numerator:"100000000",price_denominator:"100000000000000000000",
    pending:"0",estimated:"0",finalized:"5000000",marked:"0",gross:"0",fallback:"0",ticket_count:"0",
    reliable_count:"0",active_reserve:"0",collateral:"0",free:"100000000"};
}

describe("lpVaultAccountingRepository", () => {
  it("rejects liability marks without immutable pricing provenance",()=>{
    expect(()=>assertSupportedLpVaultLiabilityMarkSource("reliable_mark")).toThrow(
      "lp_vault_reliable_mark_provenance_unavailable"
    );
    expect(()=>assertSupportedLpVaultLiabilityMarkSource("gross_payout_fallback")).not.toThrow();
  });

  it("uses a transaction-scoped vault advisory lock", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await acquireLpVaultAccountingAdvisoryLock({ query } as never, "00000000-0000-4000-8000-000000000001");
    expect(query).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["lp-vault-accounting:00000000-0000-4000-8000-000000000001"]
    );
  });

  it("takes the exclusive global lock before the vault lock for reconciliation admission",async()=>{
    const calls:Array<[string,unknown[]|undefined]>=[];
    const query=vi.fn(async(sql:string,args?:unknown[])=>{
      calls.push([sql,args]);
      if(sql.includes("current_setting('legwork.financial_global_exclusive_lock'")) return {rows:[{lock_context:"held"}]};
      return {rows:sql.includes("JOIN LATERAL")?[]:[]};
    });
    await expect(admitNextLpVaultRedemption({query} as never,{
      vaultId,reconciliationSnapshotId:"00000000-0000-4000-8000-000000000099"
    })).resolves.toEqual({status:"none",vaultId});
    const globalIndex=calls.findIndex(([,args])=>args?.includes("financial-control-gate:global"));
    const vaultIndex=calls.findIndex(([,args])=>args?.includes(`lp-vault-accounting:${vaultId}`));
    expect(globalIndex).toBeGreaterThanOrEqual(0);
    expect(globalIndex).toBeLessThan(vaultIndex);
  });

  it("rejects admission before lock acquisition when the reconciliation context is absent",async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{lock_context:null}]});
    await expect(admitNextLpVaultRedemption({query} as never,{
      vaultId,reconciliationSnapshotId:"00000000-0000-4000-8000-000000000099"
    })).rejects.toThrow("lp_vault_redemption_admission_lock_order_invalid");
    expect(query).toHaveBeenCalledOnce();
  });

  it("appends the next contiguous event using the prior terminal hash", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({ rows: [{
        id: "00000000-0000-4000-8000-000000000010",
        vault_id: "00000000-0000-4000-8000-000000000001",
        book_version: "9007199254740994",
        event_type: "cycle_opened",
        entity_id: "00000000-0000-4000-8000-000000000011",
        payload: { cutoffDate: "2026-09-10" },
        payload_text: '{"cutoffDate": "2026-09-10"}',
        payload_hash: `sha256:${"b".repeat(64)}`,
        previous_event_hash: `sha256:${"a".repeat(64)}`,
        event_hash: `sha256:${"c".repeat(64)}`,
        recorded_at: new Date("2026-09-10T00:00:00.000Z")
      }] });
    const event = await appendLpVaultAccountingEvent({ query } as never, {
      vaultId: "00000000-0000-4000-8000-000000000001",
      eventType: "cycle_opened",
      entityId: "00000000-0000-4000-8000-000000000011",
      eventId: "00000000-0000-4000-8000-000000000010",
      payload: { cutoffDate: "2026-09-10" }
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain("WITH prior AS");
    expect(query.mock.calls[1][0]).toContain("book_version+1");
    expect(event.bookVersion).toBe(9007199254740994n);
  });

  it("takes the vault lock inside a READ COMMITTED transaction before mutation",async()=>{
    const statements:string[]=[];
    const client={query:vi.fn(async(sql:string)=>{statements.push(sql);return {rows:[]};}),release:vi.fn()};
    const pool={connect:vi.fn(async()=>client)};
    await runLpVaultAccountingTransaction("00000000-0000-4000-8000-000000000001",async()=>"ok",pool as never);
    expect(statements).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      "COMMIT"
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("distributes one owner-level mint across deposits exactly once",()=>{
    const split=allocateOwnerMintAcrossDeposits(10_000_000_000_000_000_001n,[
      {id:"a",amountMicroUnits:3_000_000n},{id:"b",amountMicroUnits:7_000_000n}
    ]);
    expect(split.get("a")).toBe(3_000_000_000_000_000_000n);
    expect(split.get("b")).toBe(7_000_000_000_000_000_001n);
    expect([...split.values()].reduce((sum,value)=>sum+value,0n)).toBe(10_000_000_000_000_000_001n);
  });

  it("loads the unresolved ticket set at the canonical reconciliation time", async () => {
    const canonicalTime = new Date("2026-09-10T00:03:00.000Z");
    const query = vi.fn().mockResolvedValue({ rows: [{
      ticket_id: "00000000-0000-4000-8000-000000000020",
      stake_micro_units: "1000000",
      offered_payout_micro_units: "5000000"
    }] });

    const tickets = await loadUnresolvedLpVaultTicketsAsOf({ query } as never, canonicalTime);

    expect(tickets).toHaveLength(1);
    const [sql, args] = query.mock.calls[0];
    expect(sql).toContain("reserves.created_at <= $1");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("summaries.created_at <= $1");
    expect(sql).not.toContain("reserves.status='reserved'");
    expect(args).toEqual([canonicalTime]);
  });

  it("marks redemption reserves from append-only state at the canonical time", async () => {
    const canonicalTime = new Date("2026-09-10T00:04:00.000Z");
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ net_asset_value_micro_units: "1000000", share_supply_units: "1000000000000000000" }] })
      .mockResolvedValueOnce({ rows: [] });

    const marks = await markActiveLpVaultRedemptionReserves({ query } as never, {
      vaultId: "00000000-0000-4000-8000-000000000001",
      cycleId: "00000000-0000-4000-8000-000000000002",
      checkpointId: "00000000-0000-4000-8000-000000000003",
      canonicalTime
    });

    expect(marks).toEqual([]);
    const [sql, args] = query.mock.calls[2];
    expect(sql).toContain("lp_vault_redemption_request_history");
    expect(sql).toContain("history.recorded_at <= $2");
    expect(sql).toContain("state_at_cutoff.to_status IN ('admitted', 'redeeming')");
    expect(sql).not.toContain("requests.status IN");
    expect(args).toEqual(["00000000-0000-4000-8000-000000000001", canonicalTime]);
  });

  it("finalizes only against the supplied cycle checkpoint and canonical time", async () => {
    const canonicalTime = new Date("2026-09-13T00:03:00.000Z");
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const finalized = await finalizeEligibleLpVaultRedemptions({ query } as never, {
      vaultId: "00000000-0000-4000-8000-000000000001",
      cycleId: "00000000-0000-4000-8000-000000000002",
      checkpointId: "00000000-0000-4000-8000-000000000003",
      canonicalTime
    });

    expect(finalized).toEqual([]);
    expect(query.mock.calls[1][0]).toContain("redemption_starts_at <= $2");
    expect(query.mock.calls[1][1]).toEqual(["00000000-0000-4000-8000-000000000001", canonicalTime]);
    const [sql, args] = query.mock.calls[2];
    expect(sql).toContain("marks.cycle_id=$2 AND marks.checkpoint_id=$3");
    expect(sql).toContain("checkpoints.id=$3 AND checkpoints.cycle_id=$2");
    expect(sql).toContain("requests.redemption_ends_at <= $4");
    expect(sql).not.toContain("redemption_ends_at <= now()");
    expect(sql).not.toContain("marked_at >= requests.redemption_ends_at");
    expect(args).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
      canonicalTime
    ]);
  });

  it("rejects invalid canonical timestamps before issuing temporal queries", async () => {
    const query = vi.fn();
    await expect(loadUnresolvedLpVaultTicketsAsOf({ query } as never, new Date(Number.NaN)))
      .rejects.toThrow("invalid_lp_vault_canonical_time");
    expect(query).not.toHaveBeenCalled();
  });

  it("replays closed accounting from events while accepting a pending event tail",async()=>{
    const query=vi.fn()
      .mockResolvedValueOnce({rows:replayEvents})
      .mockResolvedValueOnce({rows:[replayProjection()]})
      .mockResolvedValueOnce({rows:[shareProjection()]});
    const replay=await replayLpVaultAccounting(vaultId,{query} as never);
    expect(replay).toMatchObject({eventCount:5,lastBookVersion:5n,lastClosedBookVersion:4n,pendingTailEventCount:1,
      checkpointCount:1,shareEventCount:1,totalMintedShareUnits:100000000000000000000n,totalBurnedShareUnits:0n,
      replayedShareSupplyUnits:100000000000000000000n,checkpointShareSupplyUnits:100000000000000000000n,
      economicNavMicroUnits:100000000n,grossAssetsMicroUnits:100000000n,navDeductionsMicroUnits:0n});
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("fails replay when projections disagree with the append-only event ledger",async()=>{
    const query=vi.fn()
      .mockResolvedValueOnce({rows:replayEvents})
      .mockResolvedValueOnce({rows:[replayProjection({closing_supply:"999"})]});
    await expect(replayLpVaultAccounting(vaultId,{query} as never))
      .rejects.toThrow("lp_vault_accounting_projection_mismatch");
  });

  it("fails replay when a share projection disagrees with its accounting event",async()=>{
    const query=vi.fn()
      .mockResolvedValueOnce({rows:replayEvents})
      .mockResolvedValueOnce({rows:[replayProjection()]})
      .mockResolvedValueOnce({rows:[shareProjection(false)]});
    await expect(replayLpVaultAccounting(vaultId,{query} as never))
      .rejects.toThrow("lp_vault_accounting_share_projection_mismatch");
  });

  it("rejects value-changing events after the latest closed cycle",async()=>{
    const events=eventRows([
      ...replayEvents.slice(0,4).map(row=>({eventType:row.event_type,entityId:row.entity_id,payload:row.payload})),
      {eventType:"liquidity_marked",entityId:"00000000-0000-4000-8000-000000000014",
        payload:{activeRedemptionReserveMicroUnits:"1"}}
    ]);
    const query=vi.fn().mockResolvedValueOnce({rows:events});
    await expect(replayLpVaultAccounting(vaultId,{query} as never))
      .rejects.toThrow("lp_vault_accounting_valuing_event_after_close");
  });

  it("returns owner accounting as unavailable instead of zero when the checkpoint is stale",async()=>{
    const asOf=new Date("2026-09-01T00:00:00Z");
    const query=vi.fn().mockResolvedValueOnce({rows:[latestAccountingRow(asOf)]});
    const {pool}=readOnlyPool(query);
    await expect(loadVerifiedLpVaultOwnerAccounting(vaultId,userId,pool as never,
      {now:new Date("2026-09-03T00:00:00Z")})).resolves.toEqual({
        status:"unavailable",reason:"accounting_stale",vaultId,userId,asOf
      });
    expect(query).toHaveBeenCalledOnce();
  });

  it("fails owner accounting closed when replay and the public checkpoint disagree",async()=>{
    const asOf=new Date("2026-09-10T00:04:00Z");
    const mismatchedQuery=vi.fn()
      .mockResolvedValueOnce({rows:[{...latestAccountingRow(asOf),nav:"100000001",price_numerator:"100000001"}]})
      .mockResolvedValueOnce({rows:replayEvents})
      .mockResolvedValueOnce({rows:[replayProjection()]})
      .mockResolvedValueOnce({rows:[shareProjection()]});
    const wrapped=readOnlyPool(mismatchedQuery);
    await expect(loadVerifiedLpVaultOwnerAccounting(vaultId,userId,wrapped.pool as never,{now:asOf}))
      .rejects.toThrow("lp_vault_owner_accounting_replay_mismatch");
    expect(wrapped.client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(wrapped.client.release).toHaveBeenCalledOnce();
  });

  it("returns an exact verified owner position, pending deposits, and withdrawal lifecycle",async()=>{
    const asOf=new Date("2026-09-10T00:04:00Z");
    const query=vi.fn()
      .mockResolvedValueOnce({rows:[latestAccountingRow(asOf)]})
      .mockResolvedValueOnce({rows:replayEvents})
      .mockResolvedValueOnce({rows:[replayProjection()]})
      .mockResolvedValueOnce({rows:[shareProjection()]})
      .mockResolvedValueOnce({rows:[{id:"00000000-0000-4000-8000-000000000030",amount_micro_units:"5000000",
        eligible_after_cutoff:"2026-09-11",created_at:new Date("2026-09-10T04:00:00Z")}]})
      .mockResolvedValueOnce({rows:[{id:"00000000-0000-4000-8000-000000000031",
        active_share_units:"40000000000000000000",remaining_cost_basis_micro_units:"30000000"}]})
      .mockResolvedValueOnce({rows:[
        {id:"00000000-0000-4000-8000-000000000032",status:"queued",requested_share_units:"10000000000000000000",
          requested_at:new Date("2026-09-10T05:00:00Z"),redemption_starts_at:null,redemption_ends_at:null,
          finalized_at:null,claimable_at:null,matured_amount_micro_units:null,finalized_redemption_pnl_micro_units:null},
        {id:"00000000-0000-4000-8000-000000000033",status:"claimable",requested_share_units:"20000000000000000000",
          requested_at:new Date("2026-09-01T00:00:00Z"),redemption_starts_at:new Date("2026-09-02T00:00:00Z"),
          redemption_ends_at:new Date("2026-09-05T00:00:00Z"),finalized_at:new Date("2026-09-05T00:01:00Z"),
          claimable_at:new Date("2026-09-05T00:01:01Z"),matured_amount_micro_units:"25000000",
          finalized_redemption_pnl_micro_units:"5000000"}
      ]});
    const {pool,client}=readOnlyPool(query);
    const owner=await loadVerifiedLpVaultOwnerAccounting(vaultId,userId,pool as never,{now:asOf});
    expect(owner).toMatchObject({status:"available",activeShareUnits:40000000000000000000n,
      remainingCostBasisMicroUnits:30000000n,currentPositionValueMicroUnits:40000000n,
      estimatedPnlMicroUnits:10000000n,finalizedRedemptionPnlMicroUnits:5000000n});
    if(owner.status!=="available") throw new Error("expected owner accounting");
    expect(owner.pendingDeposits[0].amountMicroUnits).toBe(5000000n);
    expect(owner.withdrawals.map(item=>item.currentValueMicroUnits)).toEqual([10000000n,25000000n]);
    expect(query.mock.calls[5][0]).toContain("cumulative_allocated_basis_micro_units");
    expect(client.query.mock.calls[0][0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
});

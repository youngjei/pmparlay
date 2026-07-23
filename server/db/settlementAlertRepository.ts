import type pg from "pg";
import { config } from "../config";
import { sanitizeWorkerFailure } from "./workerHeartbeatRepository";
import { getPool } from "./client";

const SETTLEMENT_ALERT_KIND = "settlement_leg_attention";

export type SettlementOperationalAlert = {
  id: string;
  severity: "warning" | "critical";
  ticketLegId: string;
  ticketId: string;
  resolutionState: string;
  reason: "resolution_overdue" | "settlement_blocked" | "settlement_due_at_missing";
  marketEndDate?: string;
  overdueMs?: number;
  resolutionAttempts: number;
  lastResolutionError?: string;
  createdAt: string;
};

type SettlementAlertCandidate = Omit<SettlementOperationalAlert, "id" | "severity" | "reason" | "createdAt"> & {
  marketEndDate?: string;
};

type SyncSettlementAlertsOptions = {
  now?: Date;
  warningAfterMs?: number;
  criticalAfterMs?: number;
  limit?: number;
};

function candidateAlert(
  candidate: SettlementAlertCandidate,
  now: Date,
  criticalAfterMs: number
): Pick<SettlementOperationalAlert, "severity" | "reason" | "overdueMs"> {
  if (candidate.resolutionState === "settlement_blocked") {
    return {
      severity: "critical",
      reason: "settlement_blocked",
      overdueMs: candidate.marketEndDate ? Math.max(0, now.getTime() - Date.parse(candidate.marketEndDate)) : undefined
    };
  }

  if (!candidate.marketEndDate) {
    return {
      severity: "critical",
      reason: "settlement_due_at_missing",
      overdueMs: undefined
    };
  }

  const overdueMs = candidate.marketEndDate ? Math.max(0, now.getTime() - Date.parse(candidate.marketEndDate)) : 0;
  return {
    severity: overdueMs >= criticalAfterMs ? "critical" : "warning",
    reason: "resolution_overdue",
    overdueMs
  };
}

function alertPayload(alert: Omit<SettlementOperationalAlert, "id" | "createdAt">, evaluatedAt: Date) {
  return {
    ticketLegId: alert.ticketLegId,
    ticketId: alert.ticketId,
    severity: alert.severity,
    reason: alert.reason,
    resolutionState: alert.resolutionState,
    marketEndDate: alert.marketEndDate || null,
    overdueMs: alert.overdueMs ?? null,
    resolutionAttempts: alert.resolutionAttempts,
    lastResolutionError: alert.lastResolutionError || null,
    evaluatedAt: evaluatedAt.toISOString(),
    requiredAction:
      alert.reason === "settlement_blocked"
        ? "Inspect the frozen settlement identity and Polygon RPC quorum evidence. Do not settle manually."
        : alert.reason === "settlement_due_at_missing"
          ? "Quarantine the legacy leg and recover its immutable purchased-market end time. Do not settle manually."
        : "Verify the Polymarket resolution state and Polygon RPC health. Do not settle manually."
  };
}

async function listCandidates(
  client: pg.PoolClient,
  input: { now: Date; warningAfterMs: number; limit: number }
): Promise<SettlementAlertCandidate[]> {
  const result = await client.query<{
    ticketLegId: string;
    ticketId: string;
    resolutionState: string;
    marketEndDate: Date | null;
    resolutionAttempts: number;
    lastResolutionError: string | null;
  }>(
    `
      WITH attention_candidates AS (
        SELECT
        ticket_legs.id AS "ticketLegId",
        tickets.id AS "ticketId",
        ticket_legs.resolution_state AS "resolutionState",
        ticket_legs.settlement_due_at AS "marketEndDate",
        ticket_legs.resolution_attempts AS "resolutionAttempts",
        ticket_legs.last_resolution_error AS "lastResolutionError",
        open_incident.id AS open_incident_id,
        row_number() OVER (
          PARTITION BY (open_incident.id IS NULL)
          ORDER BY
            CASE
              WHEN open_incident.id IS NOT NULL THEN COALESCE(
                CASE
                  WHEN pg_input_is_valid(open_incident.metadata->>'evaluatedAt', 'timestamp with time zone')
                    THEN (open_incident.metadata->>'evaluatedAt')::timestamptz
                  ELSE NULL
                END,
                open_incident.created_at
              )
              ELSE NULL
            END ASC NULLS LAST,
            CASE WHEN open_incident.id IS NULL THEN (ticket_legs.resolution_state = 'settlement_blocked') ELSE NULL END DESC,
            CASE WHEN open_incident.id IS NULL THEN ticket_legs.settlement_due_at ELSE NULL END ASC NULLS FIRST,
            ticket_legs.created_at ASC
        ) AS cohort_rank
        FROM ticket_legs
        JOIN tickets ON tickets.id = ticket_legs.ticket_id
        LEFT JOIN financial_incidents AS open_incident
          ON open_incident.kind = 'settlement_leg_attention'
          AND open_incident.entity_type = 'ticket_leg'
          AND open_incident.entity_id = ticket_legs.id
          AND open_incident.status = 'open'
        WHERE ticket_legs.status IN ('pending', 'disputed')
          AND tickets.status IN ('accepted', 'live', 'won', 'lost', 'voided')
          AND (
            ticket_legs.resolution_state = 'settlement_blocked'
            OR (
              ticket_legs.settlement_frozen_at IS NOT NULL
              AND ticket_legs.settlement_due_at IS NULL
            )
            OR (
              ticket_legs.settlement_due_at IS NOT NULL
              AND ticket_legs.settlement_due_at <= $1::timestamptz - ($2::text || ' milliseconds')::interval
            )
          )
      )
      SELECT
        "ticketLegId",
        "ticketId",
        "resolutionState",
        "marketEndDate",
        "resolutionAttempts",
        "lastResolutionError"
      FROM attention_candidates
      WHERE cohort_rank <= $3
      ORDER BY
        cohort_rank ASC,
        (open_incident_id IS NULL) ASC
    `,
    [input.now, input.warningAfterMs, input.limit]
  );

  return result.rows.map((row) => ({
    ticketLegId: row.ticketLegId,
    ticketId: row.ticketId,
    resolutionState: row.resolutionState,
    marketEndDate: row.marketEndDate?.toISOString(),
    resolutionAttempts: row.resolutionAttempts,
    lastResolutionError: row.lastResolutionError ? sanitizeWorkerFailure(row.lastResolutionError) : undefined
  }));
}

async function enqueueAlertEvent(client: pg.PoolClient, topic: string, payload: unknown) {
  await client.query(
    `
      INSERT INTO outbox (topic, payload)
      VALUES ($1, $2)
    `,
    [topic, payload]
  );
}

export async function syncSettlementOperationalAlerts(options: SyncSettlementAlertsOptions = {}) {
  const now = options.now || new Date();
  const warningAfterMs = options.warningAfterMs ?? config.SETTLEMENT_OVERDUE_WARNING_MS;
  const criticalAfterMs = options.criticalAfterMs ?? config.SETTLEMENT_OVERDUE_CRITICAL_MS;
  const limit = options.limit ?? config.SETTLEMENT_ALERT_BATCH_SIZE;

  if (criticalAfterMs <= warningAfterMs) throw new Error("settlement_alert_thresholds_invalid");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const candidates = await listCandidates(client, { now, warningAfterMs, limit });
    let opened = 0;
    let escalated = 0;
    let reasonChanged = 0;

    for (const candidate of candidates) {
      const classification = candidateAlert(candidate, now, criticalAfterMs);
      const alert = {
        ...candidate,
        ...classification
      };
      const payload = alertPayload(alert, now);
      const inserted = await client.query<{ id: string }>(
        `
          INSERT INTO financial_incidents (
            severity, status, kind, entity_type, entity_id, reason, metadata
          )
          VALUES ($1, 'open', $2, 'ticket_leg', $3, $4, $5)
          ON CONFLICT (kind, entity_type, entity_id)
            WHERE status = 'open' AND kind = 'settlement_leg_attention'
          DO NOTHING
          RETURNING id
        `,
        [alert.severity, SETTLEMENT_ALERT_KIND, alert.ticketLegId, alert.reason, payload]
      );

      if (inserted.rows[0]?.id) {
        opened += 1;
        await client.query(
          `
            INSERT INTO audit_log (action, entity_type, entity_id, metadata)
            VALUES ('settlement.alert.opened', 'ticket_leg', $1, $2)
          `,
          [alert.ticketLegId, { incidentId: inserted.rows[0].id, ...payload }]
        );
        await enqueueAlertEvent(client, "settlement.alert.opened", {
          incidentId: inserted.rows[0].id,
          ...payload
        });
        continue;
      }

      const existing = await client.query<{
        id: string;
        severity: "warning" | "critical";
        reason: SettlementOperationalAlert["reason"];
      }>(
        `
          SELECT id, severity, reason
          FROM financial_incidents
          WHERE kind = $1
            AND entity_type = 'ticket_leg'
            AND entity_id = $2
            AND status = 'open'
          FOR UPDATE
        `,
        [SETTLEMENT_ALERT_KIND, alert.ticketLegId]
      );
      const incident = existing.rows[0];
      if (!incident) throw new Error("settlement_alert_upsert_lost");

      // Operational severity is monotonic until remediation. A recovered RPC
      // block must not silently downgrade a still-overdue financial incident.
      const effectiveAlert = incident.severity === "critical" ? { ...alert, severity: "critical" as const } : alert;
      const effectivePayload = alertPayload(effectiveAlert, now);

      await client.query(
        `
          UPDATE financial_incidents
          SET severity = $2, reason = $3, metadata = $4
          WHERE id = $1
        `,
        [incident.id, effectiveAlert.severity, effectiveAlert.reason, effectivePayload]
      );
      if (incident.severity !== effectiveAlert.severity || incident.reason !== effectiveAlert.reason) {
        if (incident.severity !== effectiveAlert.severity) escalated += 1;
        else reasonChanged += 1;
        const event =
          incident.severity !== effectiveAlert.severity ? "settlement.alert.escalated" : "settlement.alert.reason_changed";
        await client.query(
          `
            INSERT INTO audit_log (action, entity_type, entity_id, metadata)
            VALUES ($1, 'ticket_leg', $2, $3)
          `,
          [
            event,
            alert.ticketLegId,
            {
              incidentId: incident.id,
              previousSeverity: incident.severity,
              previousReason: incident.reason,
              ...effectivePayload
            }
          ]
        );
        await enqueueAlertEvent(client, event, {
          incidentId: incident.id,
          previousSeverity: incident.severity,
          previousReason: incident.reason,
          ...effectivePayload
        });
      }
    }

    const remediated = await client.query<{ id: string; entityId: string }>(
      `
        UPDATE financial_incidents AS incident
        SET
          status = 'remediated',
          remediated_at = $1,
          remediated_by = 'legwork_settlement_worker',
          remediation_note = 'Settlement leg no longer requires operational attention.'
        WHERE incident.kind = $2
          AND incident.entity_type = 'ticket_leg'
          AND incident.status = 'open'
          AND NOT EXISTS (
            SELECT 1
            FROM ticket_legs
            JOIN tickets ON tickets.id = ticket_legs.ticket_id
            WHERE ticket_legs.id = incident.entity_id
              AND ticket_legs.status IN ('pending', 'disputed')
              AND tickets.status IN ('accepted', 'live', 'won', 'lost', 'voided')
              AND (
                ticket_legs.resolution_state = 'settlement_blocked'
                OR (
                  ticket_legs.settlement_frozen_at IS NOT NULL
                  AND ticket_legs.settlement_due_at IS NULL
                )
                OR (
                  ticket_legs.settlement_due_at IS NOT NULL
                  AND ticket_legs.settlement_due_at <= $1::timestamptz - ($3::text || ' milliseconds')::interval
                )
              )
          )
        RETURNING incident.id, incident.entity_id AS "entityId"
      `,
      [now, SETTLEMENT_ALERT_KIND, warningAfterMs]
    );

    for (const incident of remediated.rows) {
      await client.query(
        `
          INSERT INTO audit_log (action, entity_type, entity_id, metadata)
          VALUES ('settlement.alert.remediated', 'ticket_leg', $1, $2)
        `,
        [incident.entityId, { incidentId: incident.id }]
      );
      await enqueueAlertEvent(client, "settlement.alert.remediated", {
        incidentId: incident.id,
        ticketLegId: incident.entityId
      });
    }

    await client.query("COMMIT");
    return {
      candidates: candidates.length,
      opened,
      escalated,
      reasonChanged,
      remediated: remediated.rows.length
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listOpenSettlementOperationalAlerts(limit = 100): Promise<SettlementOperationalAlert[]> {
  const result = await getPool().query<{
    id: string;
    severity: "warning" | "critical";
    ticketLegId: string;
    ticketId: string;
    resolutionState: string;
    reason: "resolution_overdue" | "settlement_blocked" | "settlement_due_at_missing";
    marketEndDate: string | null;
    overdueMs: number | null;
    resolutionAttempts: number;
    lastResolutionError: string | null;
    createdAt: Date;
  }>(
    `
      SELECT
        id,
        severity,
        entity_id AS "ticketLegId",
        metadata->>'ticketId' AS "ticketId",
        metadata->>'resolutionState' AS "resolutionState",
        reason,
        metadata->>'marketEndDate' AS "marketEndDate",
        (metadata->>'overdueMs')::double precision AS "overdueMs",
        (metadata->>'resolutionAttempts')::integer AS "resolutionAttempts",
        metadata->>'lastResolutionError' AS "lastResolutionError",
        created_at AS "createdAt"
      FROM financial_incidents
      WHERE kind = $1
        AND entity_type = 'ticket_leg'
        AND status = 'open'
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 ELSE 1 END,
        created_at ASC
      LIMIT $2
    `,
    [SETTLEMENT_ALERT_KIND, limit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    severity: row.severity,
    ticketLegId: row.ticketLegId,
    ticketId: row.ticketId,
    resolutionState: row.resolutionState,
    reason: row.reason,
    marketEndDate: row.marketEndDate || undefined,
    overdueMs: row.overdueMs ?? undefined,
    resolutionAttempts: row.resolutionAttempts,
    lastResolutionError: row.lastResolutionError || undefined,
    createdAt: row.createdAt.toISOString()
  }));
}

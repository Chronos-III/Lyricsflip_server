# Data Archiving Strategy

This document outlines the retention and archiving strategy for high-volume historical data in the Lyricsflip PostgreSQL database.

## 1. Objectives

- Maintain low query latency on high-frequency tables (`game_rounds`, `game_sessions`, `wagers`).
- Reduce primary database storage growth and backup snapshot sizes.
- Preserve audit and analytical records for compliance, dispute resolution, and reporting.

## 2. Table-Specific Retention Policies

| Table | Retention in Primary DB | Archive Policy |
|---|---|---|
| `game_rounds` | 90 days after session completion | Export to cold object storage (Parquet/CSV on S3/GCS); purge completed rounds older than 90 days. |
| `game_sessions` | 180 days after completion or abandonment | Archive completed/abandoned sessions with no open wagers. |
| `wagers` | 365 days after terminal state (`SETTLED`, `REFUNDED`, `FAILED`) | Retain financial records on-chain and in archival cold storage for tax/compliance purposes. |
| `audit_logs` | 180 days in primary database | Stream to cold storage or log aggregator (e.g. OpenSearch / BigQuery) for long-term retention. |
| `refresh_tokens` | Immediate deletion upon revocation or expiration | Scheduled cleanup job purges expired and revoked tokens automatically. |

## 3. Recommended Archive & Purge Procedure

A monthly or weekly maintenance script executes:

```sql
-- 1. Export rounds from completed sessions older than 90 days
COPY (
  SELECT r.* FROM game_rounds r
  JOIN game_sessions s ON r."sessionId" = s.id
  WHERE s.status IN ('COMPLETED', 'ABANDONED')
    AND s."updatedAt" < NOW() - INTERVAL '90 days'
) TO PROGRAM 'gzip > /archive/game_rounds_$(date +%Y%m%d).csv.gz' WITH CSV HEADER;

-- 2. Verify export checksum, then purge
DELETE FROM game_rounds
WHERE "sessionId" IN (
  SELECT id FROM game_sessions
  WHERE status IN ('COMPLETED', 'ABANDONED')
    AND "updatedAt" < NOW() - INTERVAL '90 days'
);
```

Always execute purges in bounded batches during off-peak hours to avoid prolonged table locks.
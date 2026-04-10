import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { Env } from '../config/env.js';
import { ConfigError } from '../Core/errors.js';

export type SyncRunStatus = 'pending' | 'running' | 'completed' | 'completed_with_errors' | 'failed';
export type SyncJobStatus = 'pending' | 'in_progress' | 'retry' | 'completed' | 'failed';

export interface SyncRunRow {
  id: string;
  status: SyncRunStatus;
  triggered_by: string;
  notes: string | null;
  total_jobs: number;
  completed_jobs: number;
  failed_jobs: number;
}

export interface SyncJobRow {
  id: string;
  run_id: string;
  nit: string;
  status: SyncJobStatus;
  attempts: number;
  last_error: string | null;
}

let pool: Pool | null = null;

function requireDatabaseUrl(env: Env): string {
  if (!env.databaseUrl) {
    throw new ConfigError('DATABASE_URL es obligatorio cuando APP_MODE es "scheduler" o "worker".');
  }
  return env.databaseUrl;
}

export function getDbPool(env: Env): Pool {
  if (pool) return pool;
  pool = new Pool({
    connectionString: requireDatabaseUrl(env),
    max: 10,
  });
  return pool;
}

export async function initDbSchema(env: Env): Promise<void> {
  const db = getDbPool(env);
  await db.query(`
    CREATE TABLE IF NOT EXISTS sync_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      notes TEXT NULL,
      total_jobs INTEGER NOT NULL DEFAULT 0,
      completed_jobs INTEGER NOT NULL DEFAULT 0,
      failed_jobs INTEGER NOT NULL DEFAULT 0,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS sync_jobs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
      nit TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NULL,
      worker_id TEXT NULL,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ NULL,
      finished_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(run_id, nit)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_sync_jobs_queue
    ON sync_jobs (status, available_at, created_at);
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS sync_job_results (
      job_id TEXT PRIMARY KEY REFERENCES sync_jobs(id) ON DELETE CASCADE,
      updated BOOLEAN NOT NULL DEFAULT FALSE,
      skipped_reason TEXT NULL,
      payload_siigo_resumido JSONB NULL,
      payload_hubspot_enviado JSONB NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS sync_company_state (
      nit TEXT PRIMARY KEY,
      last_seen_in_siigo_at TIMESTAMPTZ NULL,
      last_synced_at TIMESTAMPTZ NULL,
      last_status TEXT NOT NULL,
      last_total_balance NUMERIC NOT NULL DEFAULT 0,
      last_run_id TEXT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

export async function withDbClient<T>(env: Env, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getDbPool(env).connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function createSyncRun(
  env: Env,
  input: { triggeredBy: string; notes?: string | null }
): Promise<SyncRunRow> {
  const id = randomUUID();
  const res = await getDbPool(env).query<SyncRunRow>(
    `INSERT INTO sync_runs (id, status, triggered_by, notes)
     VALUES ($1, 'running', $2, $3)
     RETURNING id, status, triggered_by, notes, total_jobs, completed_jobs, failed_jobs`,
    [id, input.triggeredBy, input.notes ?? null]
  );
  return res.rows[0]!;
}

export async function enqueueSyncJobs(env: Env, runId: string, nits: string[]): Promise<number> {
  if (nits.length === 0) return 0;
  const client = await getDbPool(env).connect();
  try {
    await client.query('BEGIN');
    for (const nit of nits) {
      await client.query(
        `INSERT INTO sync_jobs (id, run_id, nit, status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT (run_id, nit) DO NOTHING`,
        [randomUUID(), runId, nit]
      );
    }
    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sync_jobs WHERE run_id = $1`,
      [runId]
    );
    const totalJobs = Number(countRes.rows[0]?.count ?? '0');
    await client.query(
      `UPDATE sync_runs SET total_jobs = $2, updated_at = NOW() WHERE id = $1`,
      [runId, totalJobs]
    );
    await client.query('COMMIT');
    return totalJobs;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function tryAcquireSchedulerLock(env: Env): Promise<boolean> {
  const res = await getDbPool(env).query<{ ok: boolean }>(
    `SELECT pg_try_advisory_lock(987654321) AS ok`
  );
  return Boolean(res.rows[0]?.ok);
}

export async function releaseSchedulerLock(env: Env): Promise<void> {
  await getDbPool(env).query(`SELECT pg_advisory_unlock(987654321)`);
}

export async function claimNextSyncJob(env: Env, workerId: string): Promise<SyncJobRow | null> {
  return withDbClient(env, async (client) => {
    await client.query('BEGIN');
    try {
      const res = await client.query<SyncJobRow>(
        `
        WITH picked AS (
          SELECT id
          FROM sync_jobs
          WHERE status IN ('pending', 'retry')
            AND available_at <= NOW()
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE sync_jobs j
        SET status = 'in_progress',
            attempts = j.attempts + 1,
            worker_id = $1,
            started_at = COALESCE(j.started_at, NOW()),
            updated_at = NOW()
        FROM picked
        WHERE j.id = picked.id
        RETURNING j.id, j.run_id, j.nit, j.status, j.attempts, j.last_error
        `,
        [workerId]
      );
      await client.query('COMMIT');
      return res.rows[0] ?? null;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

export async function completeSyncJob(
  env: Env,
  input: {
    jobId: string;
    runId: string;
    nit: string;
    updated: boolean;
    skippedReason: string | null;
    payloadSiigoResumido: unknown;
    payloadHubSpotEnviado: unknown;
    lastStatus: string;
    lastTotalBalance: number;
    seenInSiigo: boolean;
  }
): Promise<void> {
  const client = await getDbPool(env).connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE sync_jobs
       SET status = 'completed', finished_at = NOW(), updated_at = NOW(), last_error = NULL
       WHERE id = $1`,
      [input.jobId]
    );
    await client.query(
      `INSERT INTO sync_job_results (job_id, updated, skipped_reason, payload_siigo_resumido, payload_hubspot_enviado, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, NOW())
       ON CONFLICT (job_id) DO UPDATE
       SET updated = EXCLUDED.updated,
           skipped_reason = EXCLUDED.skipped_reason,
           payload_siigo_resumido = EXCLUDED.payload_siigo_resumido,
           payload_hubspot_enviado = EXCLUDED.payload_hubspot_enviado,
           updated_at = NOW()`,
      [
        input.jobId,
        input.updated,
        input.skippedReason,
        JSON.stringify(input.payloadSiigoResumido ?? null),
        JSON.stringify(input.payloadHubSpotEnviado ?? null),
      ]
    );
    await client.query(
      `INSERT INTO sync_company_state (nit, last_seen_in_siigo_at, last_synced_at, last_status, last_total_balance, last_run_id, updated_at)
       VALUES ($1, CASE WHEN $2 THEN NOW() ELSE NULL END, NOW(), $3, $4, $5, NOW())
       ON CONFLICT (nit) DO UPDATE
       SET last_seen_in_siigo_at = CASE WHEN $2 THEN NOW() ELSE sync_company_state.last_seen_in_siigo_at END,
           last_synced_at = NOW(),
           last_status = EXCLUDED.last_status,
           last_total_balance = EXCLUDED.last_total_balance,
           last_run_id = EXCLUDED.last_run_id,
           updated_at = NOW()`,
      [input.nit, input.seenInSiigo, input.lastStatus, input.lastTotalBalance, input.runId]
    );
    await client.query(
      `UPDATE sync_runs
       SET completed_jobs = (SELECT COUNT(*) FROM sync_jobs WHERE run_id = $1 AND status = 'completed'),
           failed_jobs = (SELECT COUNT(*) FROM sync_jobs WHERE run_id = $1 AND status = 'failed'),
           updated_at = NOW()
       WHERE id = $1`,
      [input.runId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function failSyncJob(
  env: Env,
  input: {
    jobId: string;
    runId: string;
    attempts: number;
    maxAttempts: number;
    retryDelayMs: number;
    errorMessage: string;
  }
): Promise<void> {
  const nextStatus: SyncJobStatus = input.attempts >= input.maxAttempts ? 'failed' : 'retry';
  const availableAt = new Date(Date.now() + input.retryDelayMs);
  await getDbPool(env).query(
    `UPDATE sync_jobs
     SET status = $2,
         last_error = $3,
         available_at = CASE WHEN $2 = 'retry' THEN $4 ELSE available_at END,
         finished_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE finished_at END,
         updated_at = NOW()
     WHERE id = $1`,
    [input.jobId, nextStatus, input.errorMessage, availableAt.toISOString()]
  );
  await getDbPool(env).query(
    `UPDATE sync_runs
     SET failed_jobs = (SELECT COUNT(*) FROM sync_jobs WHERE run_id = $1 AND status = 'failed'),
         updated_at = NOW()
     WHERE id = $1`,
    [input.runId]
  );
}

export async function finalizeSyncRun(env: Env, runId: string): Promise<SyncRunRow | null> {
  const res = await getDbPool(env).query<SyncRunRow>(
    `
    UPDATE sync_runs
    SET status = CASE
        WHEN EXISTS (SELECT 1 FROM sync_jobs WHERE run_id = $1 AND status IN ('pending', 'retry', 'in_progress')) THEN sync_runs.status
        WHEN EXISTS (SELECT 1 FROM sync_jobs WHERE run_id = $1 AND status = 'failed') THEN 'completed_with_errors'
        ELSE 'completed'
      END,
      finished_at = CASE
        WHEN EXISTS (SELECT 1 FROM sync_jobs WHERE run_id = $1 AND status IN ('pending', 'retry', 'in_progress')) THEN finished_at
        ELSE NOW()
      END,
      completed_jobs = (SELECT COUNT(*) FROM sync_jobs WHERE run_id = $1 AND status = 'completed'),
      failed_jobs = (SELECT COUNT(*) FROM sync_jobs WHERE run_id = $1 AND status = 'failed'),
      updated_at = NOW()
    WHERE id = $1
    RETURNING id, status, triggered_by, notes, total_jobs, completed_jobs, failed_jobs
    `,
    [runId]
  );
  return res.rows[0] ?? null;
}

export async function listOpenRuns(env: Env): Promise<SyncRunRow[]> {
  const res = await getDbPool(env).query<SyncRunRow>(
    `SELECT id, status, triggered_by, notes, total_jobs, completed_jobs, failed_jobs
     FROM sync_runs
     WHERE status IN ('pending', 'running')
     ORDER BY started_at ASC`
  );
  return res.rows;
}


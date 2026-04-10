import { randomUUID } from 'node:crypto';
import { getEnv } from '../config/env.js';
import { ConfigError, SyncError } from '../Core/errors.js';
import {
  claimNextSyncJob,
  completeSyncJob,
  failSyncJob,
  finalizeSyncRun,
  initDbSchema,
  type SyncJobRow,
} from '../db/index.js';
import { syncNit } from '../Sync/service.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizePayload(job: SyncJobRow, result: Awaited<ReturnType<typeof syncNit>>) {
  return {
    nit: job.nit,
    saldo_total: result.saldoTotal,
    cartera: result.cartera,
  };
}

async function processJob(workerId: string, job: SyncJobRow): Promise<void> {
  const env = getEnv();
  const opts = { timeoutMs: env.httpTimeoutMs, retries: env.httpRetries };

  try {
    const result = await syncNit(env, job.nit, opts);
    const updated = result.hubspotResult === 'updated';
    const skippedReason =
      result.hubspotResult === 'not_found'
        ? 'not_found'
        : result.hubspotResult === 'skipped_sin_cambio_relevante'
          ? 'sin_cambio_relevante'
          : result.hubspotResult === 'dry_run'
            ? 'dry_run'
            : null;

    await completeSyncJob(env, {
      jobId: job.id,
      runId: job.run_id,
      nit: job.nit,
      updated,
      skippedReason,
      payloadSiigoResumido: summarizePayload(job, result),
      payloadHubSpotEnviado: result.cartera,
      lastStatus: result.hubspotResult,
      lastTotalBalance: result.saldoTotal,
      seenInSiigo: result.hasOpenItemsInSiigo,
    });

    await finalizeSyncRun(env, job.run_id);
    console.log(`[WORKER ${workerId}] Job completado NIT ${job.nit} → ${result.hubspotResult}.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failSyncJob(env, {
      jobId: job.id,
      runId: job.run_id,
      attempts: job.attempts,
      maxAttempts: env.workerMaxAttempts,
      retryDelayMs: env.workerRetryDelayMs,
      errorMessage: message,
    });
    await finalizeSyncRun(env, job.run_id);
    console.error(`[WORKER ${workerId}] Error NIT ${job.nit}: ${message}`);
  }
}

export async function runWorkerLoop(): Promise<never> {
  const env = getEnv();
  const workerId = randomUUID();
  await initDbSchema(env);
  console.log(`Modo worker: id ${workerId}. Poll cada ${env.workerPollMs} ms.`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const job = await claimNextSyncJob(env, workerId);
      if (!job) {
        await sleep(env.workerPollMs);
        continue;
      }
      await processJob(workerId, job);
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error('Configuración:', err.message);
        process.exit(2);
      }
      if (err instanceof SyncError) {
        console.error('Worker:', err.message);
        if (err.cause) console.error(err.cause);
      } else {
        console.error('Error inesperado en worker:', err);
      }
      await sleep(env.workerPollMs);
    }
  }
}

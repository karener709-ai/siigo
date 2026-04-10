import { getEnv } from '../config/env.js';
import { ConfigError, SyncError } from '../Core/errors.js';
import {
  createSyncRun,
  enqueueSyncJobs,
  finalizeSyncRun,
  initDbSchema,
  listOpenRuns,
  releaseSchedulerLock,
  tryAcquireSchedulerLock,
} from '../db/index.js';
import { searchAllCompanyNits } from '../hubspot/company.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enqueueRun(): Promise<void> {
  const env = getEnv();
  const opts = { timeoutMs: env.httpTimeoutMs, retries: env.httpRetries };
  await initDbSchema(env);

  const locked = await tryAcquireSchedulerLock(env);
  if (!locked) {
    console.log('Scheduler: otra instancia ya tiene el lock; se omite este ciclo.');
    return;
  }

  try {
    const openRuns = await listOpenRuns(env);
    for (const run of openRuns) {
      await finalizeSyncRun(env, run.id);
    }

    let nits = await searchAllCompanyNits(env, opts);
    if (env.schedulerBatchLimit != null) {
      nits = nits.slice(0, env.schedulerBatchLimit);
    }

    const run = await createSyncRun(env, {
      triggeredBy: 'scheduler',
      notes: `Corrida automática con ${nits.length} NIT(s) detectados en HubSpot.`,
    });
    const totalJobs = await enqueueSyncJobs(env, run.id, nits);
    console.log(`Scheduler: run ${run.id} creada con ${totalJobs} job(s).`);
  } finally {
    await releaseSchedulerLock(env);
  }
}

export async function runSchedulerLoop(): Promise<never> {
  const env = getEnv();
  const intervalMs = Math.max(env.syncIntervalMinutes, 1) * 60 * 1000;
  console.log(`Modo scheduler: una corrida nueva cada ${Math.max(env.syncIntervalMinutes, 1)} minuto(s).`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await enqueueRun();
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error('Configuración:', err.message);
        process.exit(2);
      }
      if (err instanceof SyncError) {
        console.error('Scheduler:', err.message);
        if (err.cause) console.error(err.cause);
      } else {
        console.error('Error inesperado en scheduler:', err);
      }
    }
    await sleep(intervalMs);
  }
}

export async function runSchedulerOnce(): Promise<void> {
  await enqueueRun();
}

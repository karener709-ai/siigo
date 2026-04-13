import type { Env } from '../config/env.js';
import { getEnv } from '../config/env.js';
import { ConfigError, SyncError } from '../Core/errors.js';
import {
  createSyncRun,
  enqueueSyncJobs,
  finalizeSyncRun,
  hasSchedulerCalendarFire,
  initDbSchema,
  listOpenRuns,
  recordSchedulerCalendarFire,
  releaseSchedulerLock,
  tryAcquireSchedulerLock,
} from '../db/index.js';
import { searchAllCompanyNits } from '../hubspot/company.js';
import { formatDayKey, getZonedCalendarParts } from './calendar.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Encola una corrida (finaliza corridas abiertas, lista NITs HubSpot, crea run + jobs). Requiere lock previo en modo intervalo. */
export async function performEnqueueRun(env: Env): Promise<void> {
  const opts = { timeoutMs: env.httpTimeoutMs, retries: env.httpRetries };
  await initDbSchema(env);

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
}

async function enqueueRunWithLock(): Promise<void> {
  const env = getEnv();
  await initDbSchema(env);
  const locked = await tryAcquireSchedulerLock(env);
  if (!locked) {
    console.log('Scheduler: otra instancia ya tiene el lock; se omite este ciclo.');
    return;
  }
  try {
    await performEnqueueRun(env);
  } finally {
    await releaseSchedulerLock(env);
  }
}

export async function runSchedulerIntervalLoop(): Promise<never> {
  const env = getEnv();
  const intervalMs = Math.max(env.syncIntervalMinutes, 1) * 60 * 1000;
  console.log(`Modo scheduler: una corrida nueva cada ${Math.max(env.syncIntervalMinutes, 1)} minuto(s).`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await enqueueRunWithLock();
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

function minutesSinceMidnight(hour: number, minute: number): number {
  return hour * 60 + minute;
}

export async function runSchedulerCalendarLoop(): Promise<never> {
  const env = getEnv();
  const days = env.schedulerDaysOfWeek;
  if (days == null || days.length === 0) {
    console.error('Modo calendario sin SCHEDULER_DAYS_OF_WEEK: defina días 0–6 o use SYNC_INTERVAL_MINUTES.');
    process.exit(2);
  }
  const daySet = new Set(days);
  const tz = env.schedulerTimezone;
  const startM = minutesSinceMidnight(env.schedulerWindowStartHour, env.schedulerWindowStartMinute);
  const endM = env.schedulerWindowEndExclusiveMinutes;
  const pollMs = env.schedulerCalendarPollSeconds * 1000;

  const startLabel = `${String(env.schedulerWindowStartHour).padStart(2, '0')}:${String(env.schedulerWindowStartMinute).padStart(2, '0')}`;
  const endLabel =
    endM == null
      ? 'sin hora límite (resto del día)'
      : `antes de ${String(Math.floor(endM / 60)).padStart(2, '0')}:${String(endM % 60).padStart(2, '0')}`;
  console.log(
    `Modo scheduler calendario: TZ=${tz}, días JS ${[...daySet].sort((a, b) => a - b).join(', ')} (0=dom…6=sáb), desde las ${startLabel} local (${endLabel}), poll ${env.schedulerCalendarPollSeconds}s.`
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await initDbSchema(env);
      const parts = getZonedCalendarParts(new Date(), tz);
      const dayKey = formatDayKey(parts);
      const nowM = minutesSinceMidnight(parts.hour, parts.minute);
      const inWindow =
        daySet.has(parts.dow) && nowM >= startM && (endM === null || nowM < endM);

      if (inWindow) {
        const locked = await tryAcquireSchedulerLock(env);
        if (locked) {
          try {
            const already = await hasSchedulerCalendarFire(env, dayKey);
            if (!already) {
              await performEnqueueRun(env);
              await recordSchedulerCalendarFire(env, dayKey);
            }
          } finally {
            await releaseSchedulerLock(env);
          }
        }
      }
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
    await sleep(pollMs);
  }
}

export async function runSchedulerLoop(): Promise<never> {
  const env = getEnv();
  if (env.schedulerDaysOfWeek != null && env.schedulerDaysOfWeek.length > 0) {
    return runSchedulerCalendarLoop();
  }
  if (env.syncIntervalMinutes <= 0) {
    console.error(
      'Scheduler: defina SYNC_INTERVAL_MINUTES (>0) o SCHEDULER_DAYS_OF_WEEK (ej. 1,3 para lun y mié).'
    );
    process.exit(2);
  }
  return runSchedulerIntervalLoop();
}

export async function runSchedulerOnce(): Promise<void> {
  await enqueueRunWithLock();
}

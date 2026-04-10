import { runSync } from './Sync/runner.js';
import { SyncError, ConfigError } from './Core/errors.js';
import { getEnv } from './config/env.js';
import { runSchedulerLoop } from './scheduler/index.js';
import { runWorkerLoop } from './worker/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnce(): Promise<never> {
  const envBefore = getEnv();
  const result = await runSync();
  console.log(`Sync OK. Actualizadas: ${result.updated}, Sin empresa en HubSpot: ${result.skipped}`);
  if (envBefore.syncDryRun) {
    console.log(
      '(Modo DRY RUN: no hubo escritura en HubSpot. Pon SYNC_DRY_RUN=false para aplicar cambios reales.)'
    );
  } else if (envBefore.testOnlyNit && result.updated > 0) {
    console.log(
      `Para comprobar en HubSpot: empresa con nit2 = "${envBefore.testOnlyNit}" → propiedades cartera_2023/2024/2026, saldo_2025, numero_de_factura_*, centro_de_costo.`
    );
  }
  process.exit(0);
}

async function runLoop(): Promise<never> {
  const env = getEnv();
  const intervalMs = env.syncIntervalMinutes * 60 * 1000;

  console.log(`Modo automático: sync cada ${env.syncIntervalMinutes} minuto(s). Ctrl+C para salir.`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const result = await runSync();
      console.log(
        `[${new Date().toISOString()}] Sync OK. Actualizadas: ${result.updated}, Sin empresa en HubSpot o DRY RUN: ${result.skipped}. Próximo en ${env.syncIntervalMinutes} min.`
      );
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error('Configuración:', err.message);
        process.exit(2);
      }
      if (err instanceof SyncError) {
        console.error('Sync:', err.message);
        if (err.cause) console.error(err.cause);
        // En modo loop no salimos: esperamos y reintentamos en el próximo ciclo
      } else {
        console.error('Error inesperado:', err);
      }
    }

    await sleep(intervalMs);
  }
}

async function main(): Promise<void> {
  try {
    const env = getEnv();
    if (env.appMode === 'worker') {
      await runWorkerLoop();
      return;
    }
    if (env.appMode === 'scheduler') {
      await runSchedulerLoop();
      return;
    }
    if (env.syncIntervalMinutes > 0) {
      await runLoop();
    } else {
      await runOnce();
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('Configuración:', err.message);
      process.exit(2);
    }
    if (err instanceof SyncError) {
      console.error('Sync:', err.message);
      if (err.cause) console.error(err.cause);
      process.exit(1);
    }
    console.error('Error inesperado:', err);
    process.exit(1);
  }
}

main();

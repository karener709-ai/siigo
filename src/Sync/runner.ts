import { getEnv } from '../config/env.js';
import { getSiigoAccessToken } from '../siigo/auth.js';
import { applyCostCenterNames, getCostCenterMap } from '../siigo/cost-centers.js';
import { getCreditNotes } from '../siigo/credit-notes.js';
import { getOpenInvoices } from '../siigo/invoices.js';
import {
  emptyCompanyCartera,
  mapInvoicesToCarteraByNit,
  totalSaldoCarteraAbierta,
} from '../mapper/cartera.js';
import { searchNitsWithCarteraSaldoEnHubSpot, updateCompanyCartera } from '../hubspot/company.js';
import { SyncError } from '../Core/errors.js';
import { createSharedSiigoContext, syncNit } from './service.js';

/** Ejecuta el flujo completo: Siigo (auth + facturas + NC) → mapeo → actualización HubSpot. */
export async function runSync(): Promise<{ updated: number; skipped: number }> {
  const env = getEnv();
  const opts = {
    timeoutMs: env.httpTimeoutMs,
    retries: env.httpRetries,
  };
  const selectedNits = new Set([
    ...(env.testOnlyNit ? [env.testOnlyNit] : []),
    ...env.testOnlyNits,
  ]);
  const hasNitFilter = selectedNits.size > 0;

  if (env.testOnlyNit) {
    console.log(
      `Modo una sola empresa: NIT ${env.testOnlyNit} (filtro en Siigo + proceso solo ese NIT en HubSpot).`
    );
  }
  if (!env.testOnlyNit && env.testOnlyNits.length > 0) {
    console.log(
      `Modo lista de empresas: ${env.testOnlyNits.length} NIT seleccionados para prueba (${env.testOnlyNits.join(', ')}).`
    );
  }
  if (env.syncDryRun) {
    console.log('SYNC_DRY_RUN=true: no se escribirá en HubSpot.');
  }
  const seg = env.hubspot.seguimientoAfiliacion;
  if (seg != null) {
    console.log(
      `Seguimiento afiliación ACTIVO → propiedad "${seg.propertyName}" | mora="${seg.valueMora}" | al día="${seg.valueAlDia}"`
    );
  } else {
    console.log(
      'Seguimiento afiliación DESACTIVADO: define HUBSPOT_SEGUIMIENTO_AFILIACION_PROPERTY + _MORA + _AL_DIA en .env (los tres).'
    );
  }

  const token = await getSiigoAccessToken(env, opts);
  const invoices = await getOpenInvoices(env, token, opts);
  const creditNotes = await getCreditNotes(env, token, opts);
  const costCenterMap = await getCostCenterMap(env, token, opts);
  const siigoDocs = applyCostCenterNames([...invoices, ...creditNotes], costCenterMap);
  const byNitAll = mapInvoicesToCarteraByNit(siigoDocs);
  /** NITs que Siigo devuelve con al menos una factura abierta en esta corrida. */
  const siigoNitsConFacturasAbiertas = new Set(byNitAll.keys());

  const byNit = new Map(
    [...byNitAll].filter(([nit]) => (hasNitFilter ? selectedNits.has(nit) : true))
  );

  let updated = 0;
  let skipped = 0;

  if (hasNitFilter) {
    console.log(`Paso 1 — Deudores según Siigo (${selectedNits.size} NIT en esta pasada, modo prueba controlada).`);
    const sharedContext = await createSharedSiigoContext(
      {
        ...env,
        testOnlyNit: null,
        testOnlyNits: [],
      },
      opts
    );
    for (const nit of selectedNits) {
      const result = await syncNit(env, nit, opts, sharedContext);
      if (result.hubspotResult === 'dry_run') {
        skipped++;
        continue;
      }
      if (result.hubspotResult === 'updated') {
        updated++;
        const seg = env.hubspot.seguimientoAfiliacion;
        const segLog =
          seg != null
            ? ` Seguimiento afiliación (${seg.propertyName}): ${result.saldoTotal > 0 ? seg.valueMora : seg.valueAlDia}.`
            : '';
        console.log(
          `[OK] HubSpot: empresa actualizada. Busca en CRM la empresa cuya propiedad nit2 es exactamente "${nit}" y revisa cartera / saldos.${segLog}`
        );
      } else if (result.hubspotResult === 'not_found') {
        skipped++;
        console.log(
          `[SALTADO] HubSpot: no hay empresa con nit2="${nit}". Crea la empresa o ajusta nit2 para que coincida con Siigo (mismo texto).`
        );
      } else {
        skipped++;
      }
    }
  } else {
    console.log(
      `Paso 1 — Deudores según Siigo (${byNit.size} NIT en esta pasada).`
    );

    for (const [nit, cartera] of byNit) {
      if (env.syncDryRun) {
        console.log(
          `[DRY RUN] NIT ${nit} — datos que se enviarían a HubSpot (propiedad nit2 debe coincidir con este NIT):`,
          cartera
        );
        const seg = env.hubspot.seguimientoAfiliacion;
        if (seg != null) {
          const mora = totalSaldoCarteraAbierta(cartera) > 0;
          console.log(
            `[DRY RUN] Seguimiento (${seg.propertyName}): ${mora ? seg.valueMora : seg.valueAlDia} (${mora ? 'con saldo' : 'sin saldo Siigo — en real solo “al día” si HubSpot tenía saldo en cartera'})`
          );
        }
        skipped++;
        continue;
      }

      try {
        const result = await updateCompanyCartera(env, nit, cartera, opts);
        if (result === 'updated') {
          updated++;
          const seg = env.hubspot.seguimientoAfiliacion;
          const segLog =
            seg != null
              ? ` Seguimiento afiliación (${seg.propertyName}): ${totalSaldoCarteraAbierta(cartera) > 0 ? seg.valueMora : seg.valueAlDia}.`
              : '';
          console.log(
            `[OK] HubSpot: empresa actualizada. Busca en CRM la empresa cuya propiedad nit2 es exactamente "${nit}" y revisa cartera / saldos.${segLog}`
          );
        } else if (result === 'not_found') {
          skipped++;
          console.log(
            `[SALTADO] HubSpot: no hay empresa con nit2="${nit}". Crea la empresa o ajusta nit2 para que coincida con Siigo (mismo texto).`
          );
        } else {
          skipped++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new SyncError(`Error actualizando NIT ${nit} en HubSpot: ${msg}`, 'HUBSPOT_UPDATE', err);
      }
    }

    const nitsConSaldoHubSpot = await searchNitsWithCarteraSaldoEnHubSpot(env, opts);
    const pagaronSegunSiigo = nitsConSaldoHubSpot.filter((nit) => !siigoNitsConFacturasAbiertas.has(nit));

    console.log(
      `Paso 2 — Cartera aún en HubSpot pero sin factura abierta en esta corrida de Siigo: ${pagaronSegunSiigo.length} NIT (limpieza + “al día” solo si aplica).`
    );

    for (const nit of pagaronSegunSiigo) {
      if (env.syncDryRun) {
        console.log(
          `[DRY RUN] NIT ${nit}: saldo en HubSpot, no sale en Siigo ahora → se limpiaría cartera desde Siigo (vacío) y seguimiento al día si había saldo.`
        );
        skipped++;
        continue;
      }

      try {
        const result = await updateCompanyCartera(env, nit, emptyCompanyCartera(), opts);
        if (result === 'updated') {
          updated++;
          const seg = env.hubspot.seguimientoAfiliacion;
          const segLog =
            seg != null ? ` Seguimiento afiliación (${seg.propertyName}): ${seg.valueAlDia}.` : '';
          console.log(
            `[OK] HubSpot: cartera limpiada (ya no en Siigo con deuda). nit2="${nit}".${segLog}`
          );
        } else if (result === 'not_found') {
          skipped++;
          console.log(`[SALTADO] NIT ${nit}: no hay empresa con ese nit2 en HubSpot.`);
        } else {
          skipped++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new SyncError(`Error actualizando NIT ${nit} en HubSpot (paso pagados): ${msg}`, 'HUBSPOT_UPDATE', err);
      }
    }
  }

  return { updated, skipped };
}

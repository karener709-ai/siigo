import type { Env } from '../config/env.js';
import { SyncError } from '../Core/errors.js';
import type { NormalizedInvoice } from '../siigo/types.js';
import { emptyCompanyCartera, mapInvoicesToCarteraByNit, totalSaldoCarteraAbierta } from '../mapper/cartera.js';
import { applyCostCenterNames, getCostCenterMap } from '../siigo/cost-centers.js';
import { getCreditNotes } from '../siigo/credit-notes.js';
import { getOpenInvoices } from '../siigo/invoices.js';
import { getSiigoAccessToken } from '../siigo/auth.js';
import { updateCompanyCartera, type UpdateCompanyCarteraResult } from '../hubspot/company.js';

export interface SyncOptions {
  timeoutMs?: number;
  retries?: number;
}

export interface SyncNitComputation {
  nit: string;
  cartera: ReturnType<typeof emptyCompanyCartera>;
  hasOpenItemsInSiigo: boolean;
}

export interface SyncNitResult {
  nit: string;
  cartera: ReturnType<typeof emptyCompanyCartera>;
  saldoTotal: number;
  hasOpenItemsInSiigo: boolean;
  hubspotResult: UpdateCompanyCarteraResult | 'dry_run';
}

interface SharedSiigoContext {
  accessToken: string;
  costCenterMap: Map<string, string>;
  creditNotesByNit: Map<string, NormalizedInvoice[]>;
}

function envForNit(env: Env, nit: string): Env {
  return {
    ...env,
    testOnlyNit: nit,
    testOnlyNits: [],
  };
}

function buildCreditNotesByNit(creditNotes: NormalizedInvoice[]): Map<string, NormalizedInvoice[]> {
  const out = new Map<string, NormalizedInvoice[]>();
  for (const note of creditNotes) {
    const current = out.get(note.nit) ?? [];
    current.push(note);
    out.set(note.nit, current);
  }
  return out;
}

export async function createSharedSiigoContext(
  env: Env,
  options: SyncOptions = {}
): Promise<SharedSiigoContext> {
  const accessToken = await getSiigoAccessToken(env, options);
  const [costCenterMap, creditNotes] = await Promise.all([
    getCostCenterMap(env, accessToken, options),
    getCreditNotes({ ...env, testOnlyNit: null }, accessToken, options),
  ]);

  return {
    accessToken,
    costCenterMap,
    creditNotesByNit: buildCreditNotesByNit(creditNotes),
  };
}

export async function computeCarteraForNit(
  env: Env,
  nit: string,
  options: SyncOptions = {},
  sharedContext?: SharedSiigoContext
): Promise<SyncNitComputation> {
  const scopedEnv = envForNit(env, nit);
  const accessToken = sharedContext?.accessToken ?? (await getSiigoAccessToken(scopedEnv, options));
  const invoices = await getOpenInvoices(scopedEnv, accessToken, options);
  const creditNotes =
    sharedContext?.creditNotesByNit.get(nit) ??
    (await getCreditNotes(scopedEnv, accessToken, options));
  const costCenterMap = sharedContext?.costCenterMap ?? (await getCostCenterMap(scopedEnv, accessToken, options));
  const docs = applyCostCenterNames([...invoices, ...creditNotes], costCenterMap);
  const byNit = mapInvoicesToCarteraByNit(docs);
  const cartera = byNit.get(nit) ?? emptyCompanyCartera();

  return {
    nit,
    cartera,
    hasOpenItemsInSiigo: byNit.has(nit),
  };
}

export async function syncNit(
  env: Env,
  nit: string,
  options: SyncOptions = {},
  sharedContext?: SharedSiigoContext
): Promise<SyncNitResult> {
  const computed = await computeCarteraForNit(env, nit, options, sharedContext);
  const saldoTotal = totalSaldoCarteraAbierta(computed.cartera);

  if (env.syncDryRun) {
    console.log(
      `[DRY RUN] NIT ${nit} — datos que se enviarían a HubSpot (propiedad nit2 debe coincidir con este NIT):`,
      computed.cartera
    );
    const seg = env.hubspot.seguimientoAfiliacion;
    if (seg != null) {
      console.log(
        `[DRY RUN] Seguimiento (${seg.propertyName}): ${saldoTotal > 0 ? seg.valueMora : seg.valueAlDia} (${saldoTotal > 0 ? 'con saldo' : 'sin saldo Siigo — en real solo “al día” si HubSpot tenía saldo en cartera'})`
      );
    }
    return {
      nit,
      cartera: computed.cartera,
      saldoTotal,
      hasOpenItemsInSiigo: computed.hasOpenItemsInSiigo,
      hubspotResult: 'dry_run',
    };
  }

  try {
    const hubspotResult = await updateCompanyCartera(env, nit, computed.cartera, options);
    return {
      nit,
      cartera: computed.cartera,
      saldoTotal,
      hasOpenItemsInSiigo: computed.hasOpenItemsInSiigo,
      hubspotResult,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SyncError(`Error actualizando NIT ${nit} en HubSpot: ${msg}`, 'HUBSPOT_UPDATE', err);
  }
}

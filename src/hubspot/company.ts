import { z } from 'zod';
import { get, post, patch } from '../Core/http.js';
import { HubSpotError } from '../Core/errors.js';
import type { Env } from '../config/env.js';
import { totalSaldoCarteraAbierta, type CompanyCartera } from '../mapper/cartera.js';

const SearchResultsSchema = z.object({
  results: z.array(z.object({ id: z.string() })),
});

/** Propiedades numéricas de cartera que sincronizamos; sirven para saber si antes había saldo en HubSpot. */
const HUBSPOT_CARTERA_AMOUNT_PROPERTIES = [
  'cartera_2023',
  'cartera_2024',
  'saldo_2025',
  'cartera_2026',
] as const;

function parseHubSpotAmountValue(raw: unknown): number {
  if (raw == null) return 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw).trim();
  if (s === '') return 0;
  const noThousandsDots = s.replace(/\./g, '');
  const normalized = noThousandsDots.includes(',') ? noThousandsDots.replace(',', '.') : noThousandsDots;
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** True si en HubSpot hay algún saldo > 0 en los campos de cartera que maneja el sync. */
async function hubspotCompanyHadSaldoCartera(
  env: Env,
  companyId: string,
  options: { timeoutMs?: number; retries?: number }
): Promise<boolean> {
  const qs = HUBSPOT_CARTERA_AMOUNT_PROPERTIES.join(',');
  const url = `${env.hubspot.apiBaseUrl}/crm/v3/objects/companies/${companyId}?properties=${qs}`;
  const res = await get<unknown>(url, {
    headers: { Authorization: `Bearer ${env.hubspot.accessToken}` },
    timeoutMs: options.timeoutMs,
    retries: options.retries,
  });
  if (!res.ok) {
    throw new HubSpotError(`Lectura empresa ${companyId} falló: HTTP ${res.status}`, res.data);
  }
  const props =
    typeof res.data === 'object' && res.data !== null && 'properties' in res.data
      ? (res.data as { properties: Record<string, unknown> }).properties
      : {};
  for (const key of HUBSPOT_CARTERA_AMOUNT_PROPERTIES) {
    if (parseHubSpotAmountValue(props[key]) > 0) return true;
  }
  return false;
}

/**
 * NITs (nit2) con saldo > 0 en algún campo de cartera que sincronizamos.
 * Sirve para detectar “debían en HubSpot y ya no salen en Siigo con factura abierta” (pagaron).
 */
export async function searchNitsWithCarteraSaldoEnHubSpot(
  env: Env,
  options: { timeoutMs?: number; retries?: number } = {}
): Promise<string[]> {
  const url = `${env.hubspot.apiBaseUrl}/crm/v3/objects/companies/search`;
  const filterGroups = HUBSPOT_CARTERA_AMOUNT_PROPERTIES.map((propertyName) => ({
    filters: [{ propertyName, operator: 'GT' as const, value: '0' }],
  }));

  const nits = new Set<string>();
  let after: string | undefined;

  for (;;) {
    const body: Record<string, unknown> = {
      filterGroups,
      properties: ['nit2'],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await post<unknown>(url, body, {
      headers: { Authorization: `Bearer ${env.hubspot.accessToken}` },
      timeoutMs: options.timeoutMs,
      retries: options.retries,
    });

    if (!res.ok) {
      throw new HubSpotError(`Búsqueda empresas con cartera en HubSpot falló: HTTP ${res.status}`, res.data);
    }

    const payload = res.data as {
      results?: Array<{ properties?: { nit2?: string | null } }>;
      paging?: { next?: { after?: string } };
    };

    for (const row of payload.results ?? []) {
      const n = row.properties?.nit2?.trim();
      if (n) nits.add(n);
    }

    const nextAfter = payload.paging?.next?.after;
    if (typeof nextAfter === 'string' && nextAfter !== '') {
      after = nextAfter;
    } else {
      break;
    }
  }

  return [...nits];
}

export async function searchAllCompanyNits(
  env: Env,
  options: { timeoutMs?: number; retries?: number } = {}
): Promise<string[]> {
  const url = `${env.hubspot.apiBaseUrl}/crm/v3/objects/companies/search`;
  const nits = new Set<string>();
  let after: string | undefined;

  for (;;) {
    const body: Record<string, unknown> = {
      filterGroups: [{ filters: [{ propertyName: 'nit2', operator: 'HAS_PROPERTY' as const }] }],
      properties: ['nit2'],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await post<unknown>(url, body, {
      headers: { Authorization: `Bearer ${env.hubspot.accessToken}` },
      timeoutMs: options.timeoutMs,
      retries: options.retries,
    });

    if (!res.ok) {
      throw new HubSpotError(`Búsqueda de empresas con nit2 en HubSpot falló: HTTP ${res.status}`, res.data);
    }

    const payload = res.data as {
      results?: Array<{ properties?: { nit2?: string | null } }>;
      paging?: { next?: { after?: string } };
    };

    for (const row of payload.results ?? []) {
      const nit = row.properties?.nit2?.trim();
      if (nit) nits.add(nit);
    }

    const nextAfter = payload.paging?.next?.after;
    if (typeof nextAfter === 'string' && nextAfter !== '') after = nextAfter;
    else break;
  }

  return [...nits];
}

async function getCompanyIdByNit(env: Env, nit: string): Promise<string | null> {
  const url = `${env.hubspot.apiBaseUrl}/crm/v3/objects/companies/search`;
  const res = await post<unknown>(
    url,
    {
      filterGroups: [{ filters: [{ propertyName: 'nit2', operator: 'EQ', value: nit }] }],
      limit: 1,
    },
    { headers: { Authorization: `Bearer ${env.hubspot.accessToken}` } }
  );

  if (!res.ok) {
    throw new HubSpotError(`Búsqueda HubSpot falló: HTTP ${res.status}`, res.data);
  }

  const parsed = SearchResultsSchema.safeParse(res.data);
  if (!parsed.success || parsed.data.results.length === 0) return null;
  return parsed.data.results[0]!.id;
}

/** HubSpot: sin saldo no enviamos 0; tampoco valores negativos (redondeo / datos raros tras NC). */
function amountForHubSpot(n: number): string | number {
  if (!Number.isFinite(n) || n <= 0) return '';
  return n;
}

type SeguimientoPatch = 'mora' | 'al_dia' | 'omit';

function toHubSpotProperties(
  env: Env,
  data: CompanyCartera,
  seguimiento: SeguimientoPatch
): Record<string, string | number> {
  const props: Record<string, string | number> = {
    cartera_2023: amountForHubSpot(data.cartera_2023),
    numero_de_factura_2023: data.numero_de_factura_2023,
    cartera_2024: amountForHubSpot(data.cartera_2024),
    numero_de_factura_2024: data.numero_de_factura_2024,
    saldo_2025: amountForHubSpot(data.saldo_2025),
    /** En HubSpot la propiedad para números de factura 2025 es `numero_de_factura` (sin año en el nombre). */
    numero_de_factura: data.numero_de_factura_2025,
    cartera_2026: amountForHubSpot(data.cartera_2026),
    numero_de_factura_2026: data.numero_de_factura_2026,
    centro_de_costo: data.centro_de_costo,
  };

  const seg = env.hubspot.seguimientoAfiliacion;
  if (seg != null && seguimiento !== 'omit') {
    props[seg.propertyName] = seguimiento === 'mora' ? seg.valueMora : seg.valueAlDia;
  }

  return props;
}

export type UpdateCompanyCarteraResult = 'updated' | 'not_found' | 'skipped_sin_cambio_relevante';

/**
 * Actualización HubSpot por NIT.
 * Los montos siempre reflejan `data` (proveniente de Siigo).
 *
 * - Con saldo en `data` → mora y cifras de Siigo.
 * - Sin saldo en `data` y **sí** había saldo de cartera en HubSpot → limpia campos y “Afiliado al día” (pagaron vs último estado en HubSpot).
 * - Sin saldo en `data` y sin saldo en HubSpot → no PATCH (no tocar afiliados que nunca tuvieron cartera por este flujo).
 */
export async function updateCompanyCartera(
  env: Env,
  nit: string,
  data: CompanyCartera,
  options: { timeoutMs?: number; retries?: number } = {}
): Promise<UpdateCompanyCarteraResult> {
  const companyId = await getCompanyIdByNit(env, nit);
  if (companyId == null) return 'not_found';

  const saldoNuevo = totalSaldoCarteraAbierta(data);
  const hubspotTeniaSaldo = await hubspotCompanyHadSaldoCartera(env, companyId, options);

  if (saldoNuevo === 0 && !hubspotTeniaSaldo) {
    console.log(
      `[SIN CAMBIO] NIT ${nit}: Siigo sin saldo y HubSpot sin saldo en cartera; no se actualiza (no se fuerza “Afiliado al día”).`
    );
    return 'skipped_sin_cambio_relevante';
  }

  let seguimiento: SeguimientoPatch;
  if (saldoNuevo > 0) {
    seguimiento = 'mora';
  } else {
    seguimiento = 'al_dia';
  }

  const url = `${env.hubspot.apiBaseUrl}/crm/v3/objects/companies/${companyId}`;
  const res = await patch<unknown>(
    url,
    { properties: toHubSpotProperties(env, data, seguimiento) },
    {
      headers: { Authorization: `Bearer ${env.hubspot.accessToken}` },
      timeoutMs: options.timeoutMs,
      retries: options.retries,
    }
  );

  if (!res.ok) {
    throw new HubSpotError(`Error actualizando empresa ${nit} (${companyId}): HTTP ${res.status}`, res.data);
  }
  return 'updated';
}

import { get } from '../Core/http.js';
import { SiigoError } from '../Core/errors.js';
import { SiigoInvoiceListItemSchema, type NormalizedInvoice, type SiigoInvoiceListItem } from './types.js';
import type { Env } from '../config/env.js';

/** Pausa entre páginas al listar facturas (límite Siigo ~100 req/min; sin esto aparece 429). */
const INVOICES_PAGE_DELAY_MS = 1200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractInvoiceRows(data: unknown): unknown[] {
  if (data == null) return [];
  if (Array.isArray(data)) return data;
  if (typeof data === 'object' && data !== null && 'results' in data) {
    const r = (data as { results: unknown }).results;
    if (Array.isArray(r)) return r;
  }
  return [];
}

function parseNextListUrl(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const href = (data as { _links?: { next?: { href?: string } } })._links?.next?.href;
  return typeof href === 'string' && href.trim() !== '' ? href.trim() : null;
}

/** Filtro oficial Siigo en GET /invoices (reduce páginas cuando pruebas con un solo NIT). */
function withCustomerIdentificationIfNeeded(urlStr: string, nit: string | null): string {
  if (nit == null || nit.trim() === '') return urlStr;
  try {
    const u = new URL(urlStr);
    u.searchParams.set('customer_identification', nit.trim());
    return u.toString();
  } catch {
    return urlStr;
  }
}

function costCenterLabel(cc: SiigoInvoiceListItem['cost_center']): string {
  if (cc == null) return '';
  if (typeof cc === 'object' && 'name' in cc && cc.name != null && String(cc.name).trim() !== '') {
    return String(cc.name);
  }
  if (typeof cc === 'number' || typeof cc === 'string') return String(cc);
  return '';
}

function normalizeListItem(item: SiigoInvoiceListItem): NormalizedInvoice | null {
  const issueDate = item.issue_date ?? item.date;
  if (!issueDate) return null;
  /** Saldo 0 se ignora. Saldo negativo = nota crédito u abono en listado; se resta en el agregado por NIT/año. */
  if (item.balance === 0) return null;

  const date = new Date(issueDate);
  const year = date.getFullYear();
  if (Number.isNaN(year)) return null;

  return {
    document_type: 'invoice',
    nit: item.customer.identification,
    year,
    invoice_number: String(item.number),
    balance: Number(item.balance),
    cost_center: costCenterLabel(item.cost_center),
    date: issueDate,
    raw: item,
  };
}

/**
 * Obtiene facturas abiertas de Siigo y las normaliza; valida con Zod.
 * Con `env.testOnlyNit`, añade `customer_identification` a cada URL (una sola empresa en Siigo).
 * Si `env.siigoInvoicesMaxPages` es un número, solo pide hasta esa cantidad de páginas.
 */
export async function getOpenInvoices(
  env: Env,
  accessToken: string,
  options: { timeoutMs?: number; retries?: number } = {}
): Promise<NormalizedInvoice[]> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Partner-Id': env.siigo.partnerId,
  };

  // Primera petición sin forzar page_size: en algunos tenants `page_size=100` provoca HTTP 500 en Siigo.
  const firstUrl = withCustomerIdentificationIfNeeded(`${env.siigo.apiBaseUrl}/invoices`, env.testOnlyNit);
  let url: string | null = firstUrl;
  const normalized: NormalizedInvoice[] = [];
  let pagesDone = 0;

  while (url) {
    const res = await get<unknown>(url, {
      headers,
      timeoutMs: options.timeoutMs,
      retries: options.retries,
    });

    if (!res.ok) {
      throw new SiigoError(`Error obteniendo facturas: HTTP ${res.status}`, res.data);
    }

    const isLegacyArray = Array.isArray(res.data);
    const isPaged =
      typeof res.data === 'object' &&
      res.data !== null &&
      'results' in res.data &&
      Array.isArray((res.data as { results: unknown }).results);

    if (!isLegacyArray && !isPaged) {
      throw new SiigoError(
        'Respuesta de facturas sin formato conocido (array o objeto con results[])',
        res.data
      );
    }

    const rows = extractInvoiceRows(res.data);

    for (const row of rows) {
      const parsed = SiigoInvoiceListItemSchema.safeParse(row);
      if (!parsed.success) {
        throw new SiigoError(`Factura en listado inválida: ${parsed.error.message}`, row);
      }
      const n = normalizeListItem(parsed.data);
      if (n) normalized.push(n);
    }

    pagesDone++;
    let next = parseNextListUrl(res.data);
    if (next != null) {
      next = withCustomerIdentificationIfNeeded(next, env.testOnlyNit);
    }
    if (env.siigoInvoicesMaxPages != null && pagesDone >= env.siigoInvoicesMaxPages) {
      next = null;
    }
    if (next) {
      await sleep(INVOICES_PAGE_DELAY_MS);
    }
    url = next;
  }

  return normalized;
}

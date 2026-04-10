import { get } from '../Core/http.js';
import { SiigoError } from '../Core/errors.js';
import {
  SiigoCreditNoteListItemSchema,
  type NormalizedInvoice,
  type SiigoCreditNoteListItem,
} from './types.js';
import type { Env } from '../config/env.js';

const CREDIT_NOTES_PAGE_DELAY_MS = 1200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRows(data: unknown): unknown[] {
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
  const obj = data as {
    _links?: { next?: { href?: string } };
    __links?: { next?: { href?: string } };
  };
  const href = obj._links?.next?.href ?? obj.__links?.next?.href;
  return typeof href === 'string' && href.trim() !== '' ? href.trim() : null;
}

function costCenterLabel(cc: SiigoCreditNoteListItem['cost_center']): string {
  if (cc == null) return '';
  if (typeof cc === 'object' && 'name' in cc && cc.name != null && String(cc.name).trim() !== '') {
    return String(cc.name);
  }
  if (typeof cc === 'number' || typeof cc === 'string') return String(cc);
  return '';
}

function normalizeCreditNote(item: SiigoCreditNoteListItem): NormalizedInvoice | null {
  const sourceDate = item.invoice_data?.date?.trim() || item.date;
  const date = new Date(sourceDate);
  const year = date.getFullYear();
  if (Number.isNaN(year)) return null;
  if (!Number.isFinite(item.total) || item.total === 0) return null;

  return {
    document_type: 'credit_note',
    nit: item.customer.identification,
    year,
    invoice_number: item.invoice?.name?.trim() || item.name.trim(),
    balance: -Math.abs(Number(item.total)),
    cost_center: costCenterLabel(item.cost_center),
    date: sourceDate,
    raw: item,
  };
}

export async function getCreditNotes(
  env: Env,
  accessToken: string,
  options: { timeoutMs?: number; retries?: number } = {}
): Promise<NormalizedInvoice[]> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Partner-Id': env.siigo.partnerId,
  };

  let url: string | null = `${env.siigo.apiBaseUrl}/credit-notes`;
  const normalized: NormalizedInvoice[] = [];
  let pagesDone = 0;

  while (url) {
    const res = await get<unknown>(url, {
      headers,
      timeoutMs: options.timeoutMs,
      retries: options.retries,
    });

    if (!res.ok) {
      throw new SiigoError(`Error obteniendo notas crédito: HTTP ${res.status}`, res.data);
    }

    const isLegacyArray = Array.isArray(res.data);
    const isPaged =
      typeof res.data === 'object' &&
      res.data !== null &&
      'results' in res.data &&
      Array.isArray((res.data as { results: unknown }).results);

    if (!isLegacyArray && !isPaged) {
      throw new SiigoError(
        'Respuesta de notas crédito sin formato conocido (array o objeto con results[])',
        res.data
      );
    }

    const rows = extractRows(res.data);

    for (const row of rows) {
      const parsed = SiigoCreditNoteListItemSchema.safeParse(row);
      if (!parsed.success) {
        throw new SiigoError(`Nota crédito inválida en listado: ${parsed.error.message}`, row);
      }
      if (env.testOnlyNit && parsed.data.customer.identification !== env.testOnlyNit) {
        continue;
      }
      const n = normalizeCreditNote(parsed.data);
      if (n) normalized.push(n);
    }

    pagesDone++;
    let next = parseNextListUrl(res.data);
    if (env.siigoInvoicesMaxPages != null && pagesDone >= env.siigoInvoicesMaxPages) {
      next = null;
    }
    if (next) {
      await sleep(CREDIT_NOTES_PAGE_DELAY_MS);
    }
    url = next;
  }

  return normalized;
}

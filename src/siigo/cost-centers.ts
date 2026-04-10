import { get } from '../Core/http.js';
import { SiigoError } from '../Core/errors.js';
import type { Env } from '../config/env.js';
import type { NormalizedInvoice } from './types.js';

interface SiigoCostCenterItem {
  id: number;
  code?: string;
  name?: string;
  active?: boolean;
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

function parseCostCenters(rows: unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    if (typeof row !== 'object' || row == null) continue;
    const cc = row as SiigoCostCenterItem;
    if (typeof cc.id !== 'number' || !Number.isFinite(cc.id)) continue;
    if (typeof cc.name !== 'string' || cc.name.trim() === '') continue;
    out.set(String(cc.id), cc.name.trim());
  }
  return out;
}

export async function getCostCenterMap(
  env: Env,
  accessToken: string,
  options: { timeoutMs?: number; retries?: number } = {}
): Promise<Map<string, string>> {
  const res = await get<unknown>(`${env.siigo.apiBaseUrl}/cost-centers`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Partner-Id': env.siigo.partnerId,
    },
    timeoutMs: options.timeoutMs,
    retries: options.retries,
  });

  if (!res.ok) {
    throw new SiigoError(`Error obteniendo centros de costo: HTTP ${res.status}`, res.data);
  }

  return parseCostCenters(extractRows(res.data));
}

export function applyCostCenterNames(
  docs: NormalizedInvoice[],
  costCenters: Map<string, string>
): NormalizedInvoice[] {
  return docs.map((doc) => {
    const raw = doc.cost_center.trim();
    if (raw === '') return doc;
    const resolved = costCenters.get(raw);
    if (!resolved) return doc;
    return { ...doc, cost_center: resolved };
  });
}

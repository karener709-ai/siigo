import { getEnvSiigoOnly } from '../config/env.js';
import { getSiigoAccessToken } from '../siigo/auth.js';
import { get } from '../Core/http.js';
import { ConfigError, SyncError } from '../Core/errors.js';

function extractRows(data: unknown): unknown[] {
  if (data == null) return [];
  if (Array.isArray(data)) return data;
  if (typeof data === 'object' && data !== null && 'results' in data) {
    const r = (data as { results: unknown }).results;
    if (Array.isArray(r)) return r;
  }
  return [];
}

async function main(): Promise<void> {
  const env = getEnvSiigoOnly();
  const opts = { timeoutMs: env.httpTimeoutMs, retries: env.httpRetries };

  let url = `${env.siigo.apiBaseUrl}/invoices`;
  if (env.testOnlyNit) {
    const u = new URL(url);
    u.searchParams.set('customer_identification', env.testOnlyNit.trim());
    url = u.toString();
  }

  console.log('=== Volcado Siigo GET /invoices (respuesta cruda) ===');
  console.log(`URL: ${url}`);
  console.log(`TEST_ONLY_NIT en .env: ${env.testOnlyNit ?? '(no definido — todas las facturas primera página)'}\n`);

  const token = await getSiigoAccessToken(env, opts);
  const res = await get<unknown>(url, {
    headers: { Authorization: `Bearer ${token}`, 'Partner-Id': env.siigo.partnerId },
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
  });

  if (!res.ok) {
    console.error('HTTP', res.status, JSON.stringify(res.data, null, 2));
    process.exit(1);
  }

  const rows = extractRows(res.data);
  console.log(`Filas en esta respuesta: ${rows.length}\n`);

  rows.forEach((row, i) => {
    console.log(`--- Documento ${i + 1} ---`);
    console.log(JSON.stringify(row, null, 2));
    console.log('');
  });

  if (typeof res.data === 'object' && res.data !== null && '_links' in res.data) {
    console.log('--- _links (paginación) ---');
    console.log(JSON.stringify((res.data as { _links: unknown })._links, null, 2));
  }
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error('Config:', err.message);
    process.exit(2);
  }
  if (err instanceof SyncError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});

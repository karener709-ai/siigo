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

  console.log('=== Volcado Siigo GET /credit-notes (respuesta cruda) ===');
  console.log(`TEST_ONLY_NIT en .env: ${env.testOnlyNit ?? '(no definido)'}`);

  const token = await getSiigoAccessToken(env, opts);
  const res = await get<unknown>(`${env.siigo.apiBaseUrl}/credit-notes`, {
    headers: { Authorization: `Bearer ${token}`, 'Partner-Id': env.siigo.partnerId },
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
  });

  if (!res.ok) {
    console.error('HTTP', res.status, JSON.stringify(res.data, null, 2));
    process.exit(1);
  }

  const rows = extractRows(res.data);
  const filtered = env.testOnlyNit
    ? rows.filter((row) => {
        const nit =
          typeof row === 'object' && row != null && 'customer' in row
            ? (row as { customer?: { identification?: string } }).customer?.identification
            : undefined;
        return nit === env.testOnlyNit;
      })
    : rows;

  console.log(`Filas para el NIT filtrado: ${filtered.length}\n`);
  filtered.forEach((row, i) => {
    console.log(`--- Nota crédito ${i + 1} ---`);
    console.log(JSON.stringify(row, null, 2));
    console.log('');
  });
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

import { getEnv } from '../config/env.js';
import { post } from '../Core/http.js';
import { ConfigError, HubSpotError, SyncError } from '../Core/errors.js';

async function main(): Promise<void> {
  const env = getEnv();
  const url = `${env.hubspot.apiBaseUrl}/crm/v3/objects/companies/search`;
  const res = await post<unknown>(
    url,
    {
      filterGroups: [{ filters: [{ propertyName: 'nit2', operator: 'HAS_PROPERTY' }] }],
      properties: ['name', 'nit2'],
      limit: 15,
    },
    {
      headers: { Authorization: `Bearer ${env.hubspot.accessToken}` },
      timeoutMs: env.httpTimeoutMs,
      retries: env.httpRetries,
    }
  );

  if (!res.ok) {
    throw new HubSpotError(`No se pudo consultar empresas en HubSpot: HTTP ${res.status}`, res.data);
  }

  const payload = res.data as {
    results?: Array<{ id?: string; properties?: { name?: string | null; nit2?: string | null } }>;
  };

  const rows = (payload.results ?? [])
    .map((row) => ({
      id: row.id ?? '',
      name: row.properties?.name?.trim() ?? '',
      nit2: row.properties?.nit2?.trim() ?? '',
    }))
    .filter((row) => /^\d{8,15}$/.test(row.nit2));

  console.log(JSON.stringify(rows, null, 2));
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error('Configuración:', err.message);
    process.exit(2);
  }
  if (err instanceof SyncError) {
    console.error(err.message);
    if (err.cause) console.error(err.cause);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});

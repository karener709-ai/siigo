import { getEnv } from '../config/env.js';
import { post } from '../Core/http.js';
import { ConfigError, HubSpotError, SyncError } from '../Core/errors.js';

async function main(): Promise<void> {
  const env = getEnv();
  const seg = env.hubspot.seguimientoAfiliacion;
  if (seg == null) {
    throw new ConfigError(
      'Debe definir HUBSPOT_SEGUIMIENTO_AFILIACION_PROPERTY y HUBSPOT_SEGUIMIENTO_AFILIACION_MORA para consultar empresas en mora.'
    );
  }

  const url = `${env.hubspot.apiBaseUrl}/crm/v3/objects/companies/search`;
  const res = await post<unknown>(
    url,
    {
      filterGroups: [
        {
          filters: [
            { propertyName: 'nit2', operator: 'HAS_PROPERTY' },
            { propertyName: seg.propertyName, operator: 'EQ', value: seg.valueMora },
          ],
        },
      ],
      properties: ['name', 'nit2', seg.propertyName, 'cartera_2023', 'cartera_2024', 'saldo_2025', 'cartera_2026'],
      limit: 20,
    },
    {
      headers: { Authorization: `Bearer ${env.hubspot.accessToken}` },
      timeoutMs: env.httpTimeoutMs,
      retries: env.httpRetries,
    }
  );

  if (!res.ok) {
    throw new HubSpotError(`No se pudo consultar empresas en mora en HubSpot: HTTP ${res.status}`, res.data);
  }

  const payload = res.data as {
    results?: Array<{
      id?: string;
      properties?: Record<string, string | null | undefined>;
    }>;
  };

  const rows = (payload.results ?? [])
    .map((row) => ({
      id: row.id ?? '',
      name: row.properties?.name?.trim() ?? '',
      nit2: row.properties?.nit2?.trim() ?? '',
      seguimiento: row.properties?.[seg.propertyName] ?? '',
      cartera_2023: row.properties?.cartera_2023 ?? '',
      cartera_2024: row.properties?.cartera_2024 ?? '',
      saldo_2025: row.properties?.saldo_2025 ?? '',
      cartera_2026: row.properties?.cartera_2026 ?? '',
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

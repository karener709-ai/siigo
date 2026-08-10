import { getEnv } from '../config/env.js';
import { get, post } from '../Core/http.js';
import { ConfigError, HubSpotError, SyncError } from '../Core/errors.js';

interface PropertyOption {
  label: string;
  value: string;
}

interface PropertyDefinition {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  options?: PropertyOption[];
}

const CEO_HINT = /presidente|ceo|gerente\s*general/i;

async function findCeoLikeProperties(env: ReturnType<typeof getEnv>): Promise<PropertyDefinition[]> {
  const url = `${env.hubspot.apiBaseUrl}/crm/v3/properties/contacts`;
  const res = await get<{ results: PropertyDefinition[] }>(url, {
    headers: { Authorization: `Bearer ${env.hubspot.accessToken}` },
    timeoutMs: env.httpTimeoutMs,
    retries: env.httpRetries,
  });
  if (!res.ok) {
    throw new HubSpotError(`No se pudo listar propiedades de contacto: HTTP ${res.status}`, res.data);
  }
  const results = res.data.results ?? [];
  return results.filter((p) => {
    if (!p.options || p.options.length === 0) return false;
    return p.options.some((o) => CEO_HINT.test(o.label) || CEO_HINT.test(o.value));
  });
}

async function getCompanyIdByNit(env: ReturnType<typeof getEnv>, nit: string): Promise<string | null> {
  const url = `${env.hubspot.apiBaseUrl}/crm/v3/objects/companies/search`;
  const res = await post<{ results: Array<{ id: string }> }>(
    url,
    { filterGroups: [{ filters: [{ propertyName: 'nit2', operator: 'EQ', value: nit }] }], limit: 1 },
    { headers: { Authorization: `Bearer ${env.hubspot.accessToken}` }, timeoutMs: env.httpTimeoutMs, retries: env.httpRetries }
  );
  if (!res.ok) {
    throw new HubSpotError(`Búsqueda de empresa por nit2 falló: HTTP ${res.status}`, res.data);
  }
  return res.data.results?.[0]?.id ?? null;
}

async function getAssociatedContactIds(env: ReturnType<typeof getEnv>, companyId: string): Promise<string[]> {
  const url = `${env.hubspot.apiBaseUrl}/crm/v4/objects/companies/${companyId}/associations/contacts`;
  const res = await get<{ results: Array<{ toObjectId: string }> }>(url, {
    headers: { Authorization: `Bearer ${env.hubspot.accessToken}` },
    timeoutMs: env.httpTimeoutMs,
    retries: env.httpRetries,
  });
  if (!res.ok) {
    throw new HubSpotError(`No se pudo leer contactos asociados de la empresa ${companyId}: HTTP ${res.status}`, res.data);
  }
  return (res.data.results ?? []).map((r) => r.toObjectId);
}

async function getContactsBatch(
  env: ReturnType<typeof getEnv>,
  contactIds: string[],
  extraProperties: string[]
): Promise<Array<{ id: string; properties: Record<string, string | null> }>> {
  if (contactIds.length === 0) return [];
  const url = `${env.hubspot.apiBaseUrl}/crm/v3/objects/contacts/batch/read`;
  const properties = [...new Set(['email', 'firstname', 'lastname', ...extraProperties])];
  const res = await post<{ results: Array<{ id: string; properties: Record<string, string | null> }> }>(
    url,
    { properties, inputs: contactIds.map((id) => ({ id })) },
    { headers: { Authorization: `Bearer ${env.hubspot.accessToken}` }, timeoutMs: env.httpTimeoutMs, retries: env.httpRetries }
  );
  if (!res.ok) {
    throw new HubSpotError(`Lectura de contactos en lote falló: HTTP ${res.status}`, res.data);
  }
  return res.data.results ?? [];
}

async function main(): Promise<void> {
  const env = getEnv();

  console.log('=== Paso 1: buscando propiedades de contacto con opciones tipo CEO/Presidente/Gerente General ===');
  const candidates = await findCeoLikeProperties(env);
  if (candidates.length === 0) {
    console.log('No se encontró ninguna propiedad de contacto con opciones que mencionen CEO/Presidente/Gerente General.');
  }
  for (const prop of candidates) {
    console.log(`\nPropiedad: name="${prop.name}" label="${prop.label}" tipo=${prop.type}/${prop.fieldType}`);
    for (const opt of prop.options ?? []) {
      const marker = CEO_HINT.test(opt.label) || CEO_HINT.test(opt.value) ? '  <-- CEO/Presidente/Gerente' : '';
      console.log(`  - value="${opt.value}" label="${opt.label}"${marker}`);
    }
  }

  if (!env.testOnlyNit) {
    console.log('\n(Define TEST_ONLY_NIT para además ver los contactos asociados de una empresa de prueba.)');
    return;
  }

  console.log(`\n=== Paso 2: contactos asociados a la empresa con nit2="${env.testOnlyNit}" ===`);
  const companyId = await getCompanyIdByNit(env, env.testOnlyNit);
  if (companyId == null) {
    console.log(`No hay empresa con nit2="${env.testOnlyNit}" en HubSpot.`);
    return;
  }
  console.log(`Empresa encontrada: id=${companyId}`);

  const contactIds = await getAssociatedContactIds(env, companyId);
  console.log(`Contactos asociados: ${contactIds.length}`);
  if (contactIds.length === 0) return;

  const extraProps = candidates.map((c) => c.name);
  const contacts = await getContactsBatch(env, contactIds, extraProps);
  for (const contact of contacts) {
    console.log(`\nContacto id=${contact.id}`);
    console.log(JSON.stringify(contact.properties, null, 2));
  }
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
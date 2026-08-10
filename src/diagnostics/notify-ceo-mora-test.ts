import { getEnv } from '../config/env.js';
import { get, post } from '../Core/http.js';
import { ConfigError, HubSpotError, SyncError } from '../Core/errors.js';

/**
 * Prueba controlada: dado TEST_ONLY_NIT, si la empresa tiene dias_en_mora > umbral,
 * busca el contacto asociado con cargo CEO/Presidente/Gerente General y envía (o simula)
 * el correo automatizado de HubSpot (MORA_EMAIL_ID) solo a ese contacto.
 *
 * Variables usadas (fuera del esquema principal, solo para esta prueba):
 *  - MORA_EMAIL_ID (obligatoria): id numérico del correo automatizado en HubSpot.
 *  - MORA_NOTIFY_THRESHOLD_DAYS (opcional, default 120)
 *  - NOTIFY_DRY_RUN (opcional, default true: no envía, solo muestra a quién enviaría)
 */
const CEO_PROPERTY = 'cargo_especifico';
const CEO_VALUE = 'PRESIDENTE/CEO/GERENTE GENERAL';

type Env2 = ReturnType<typeof getEnv>;

function getThresholdDays(): number {
  const raw = process.env.MORA_NOTIFY_THRESHOLD_DAYS;
  const n = raw ? Number(raw) : 120;
  return Number.isFinite(n) && n > 0 ? n : 120;
}

function isDryRun(): boolean {
  return String(process.env.NOTIFY_DRY_RUN ?? 'true').trim().toLowerCase() !== 'false';
}

function getEmailId(): number {
  const raw = process.env.MORA_EMAIL_ID?.trim();
  if (!raw) {
    throw new ConfigError('Defina MORA_EMAIL_ID (id numérico del correo automatizado en HubSpot).');
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new ConfigError(`MORA_EMAIL_ID inválido: "${raw}"`);
  }
  return n;
}

async function getCompanyByNit(
  env: Env2,
  nit: string
): Promise<{ id: string; diasEnMora: number; name: string } | null> {
  const url = `${env.hubspot.apiBaseUrl}/crm/v3/objects/companies/search`;
  const res = await post<{
    results: Array<{ id: string; properties: Record<string, string | null> }>;
  }>(
    url,
    {
      filterGroups: [{ filters: [{ propertyName: 'nit2', operator: 'EQ', value: nit }] }],
      properties: ['dias_en_mora', 'name'],
      limit: 1,
    },
    { headers: { Authorization: `Bearer ${env.hubspot.accessToken}` }, timeoutMs: env.httpTimeoutMs, retries: env.httpRetries }
  );
  if (!res.ok) {
    throw new HubSpotError(`Búsqueda de empresa por nit2 falló: HTTP ${res.status}`, res.data);
  }
  const row = res.data.results?.[0];
  if (!row) return null;
  const dias = Number(row.properties.dias_en_mora ?? '0');
  return {
    id: row.id,
    diasEnMora: Number.isFinite(dias) ? dias : 0,
    name: row.properties.name ?? '(sin nombre)',
  };
}

async function getAssociatedContactIds(env: Env2, companyId: string): Promise<string[]> {
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

async function findCeoContact(
  env: Env2,
  companyId: string
): Promise<{ id: string; email: string; firstname: string; lastname: string } | null> {
  const contactIds = await getAssociatedContactIds(env, companyId);
  if (contactIds.length === 0) return null;

  const url = `${env.hubspot.apiBaseUrl}/crm/v3/objects/contacts/batch/read`;
  const res = await post<{
    results: Array<{ id: string; properties: Record<string, string | null> }>;
  }>(
    url,
    {
      properties: ['email', 'firstname', 'lastname', CEO_PROPERTY],
      inputs: contactIds.map((id) => ({ id })),
    },
    { headers: { Authorization: `Bearer ${env.hubspot.accessToken}` }, timeoutMs: env.httpTimeoutMs, retries: env.httpRetries }
  );
  if (!res.ok) {
    throw new HubSpotError(`Lectura de contactos en lote falló: HTTP ${res.status}`, res.data);
  }

  for (const contact of res.data.results ?? []) {
    const raw = contact.properties[CEO_PROPERTY] ?? '';
    const values = raw.split(';').map((v) => v.trim());
    if (values.includes(CEO_VALUE)) {
      return {
        id: contact.id,
        email: contact.properties.email ?? '',
        firstname: contact.properties.firstname ?? '',
        lastname: contact.properties.lastname ?? '',
      };
    }
  }
  return null;
}

async function sendSingleEmail(env: Env2, emailId: number, toEmail: string): Promise<void> {
  const url = `${env.hubspot.apiBaseUrl}/marketing/v3/transactional/single-email/send`;
  const res = await post<unknown>(
    url,
    { emailId, message: { to: toEmail } },
    { headers: { Authorization: `Bearer ${env.hubspot.accessToken}` }, timeoutMs: env.httpTimeoutMs, retries: env.httpRetries }
  );
  if (!res.ok) {
    throw new HubSpotError(`Envío de correo (emailId=${emailId}) a ${toEmail} falló: HTTP ${res.status}`, res.data);
  }
  console.log(`[OK] Correo enviado a ${toEmail}. Respuesta:`, JSON.stringify(res.data));
}

async function main(): Promise<void> {
  const env = getEnv();
  const nit = env.testOnlyNit;
  if (!nit) {
    throw new ConfigError('Defina TEST_ONLY_NIT con el NIT de la empresa de prueba.');
  }
  const emailId = getEmailId();
  const threshold = getThresholdDays();
  const dryRun = isDryRun();

  console.log(`NIT de prueba: ${nit}`);
  console.log(`Umbral de mora: > ${threshold} días`);
  console.log(`MORA_EMAIL_ID: ${emailId}`);
  console.log(`Modo: ${dryRun ? 'DRY RUN (no envía)' : 'REAL (sí envía)'}`);

  const company = await getCompanyByNit(env, nit);
  if (!company) {
    console.log(`No hay empresa con nit2="${nit}" en HubSpot.`);
    return;
  }
  console.log(`\nEmpresa: "${company.name}" (id=${company.id}) — dias_en_mora=${company.diasEnMora}`);

  if (company.diasEnMora <= threshold) {
    console.log(`No supera el umbral (${company.diasEnMora} <= ${threshold}). No se notifica.`);
    return;
  }

  const ceo = await findCeoContact(env, company.id);
  if (!ceo) {
    console.log(`No se encontró ningún contacto asociado con ${CEO_PROPERTY} = "${CEO_VALUE}".`);
    return;
  }
  console.log(
    `\nContacto CEO encontrado: ${ceo.firstname} ${ceo.lastname} <${ceo.email}> (id=${ceo.id})`
  );

  if (!ceo.email) {
    console.log('El contacto CEO no tiene email registrado; no se puede enviar.');
    return;
  }

  if (dryRun) {
    console.log(`\n[DRY RUN] Se enviaría el correo (emailId=${emailId}) a ${ceo.email}. No se envió nada.`);
    return;
  }

  await sendSingleEmail(env, emailId, ceo.email);
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
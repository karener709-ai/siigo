import { getEnv } from '../config/env.js';
import { getSiigoAccessToken } from '../siigo/auth.js';
import { getOpenInvoices } from '../siigo/invoices.js';
import { get } from '../Core/http.js';
import { ConfigError, SyncError } from '../Core/errors.js';

function mask(value: string): string {
  if (!value || value.length < 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function diagnose(): Promise<void> {
  const env = getEnv();
  const opts = {
    timeoutMs: env.httpTimeoutMs,
    retries: env.httpRetries,
  };

  console.log('=== Diagnostico de credenciales (Siigo y HubSpot) ===');
  console.log(`SIIGO_AUTH_URL: ${env.siigo.authUrl}`);
  console.log(`SIIGO_API_BASE_URL: ${env.siigo.apiBaseUrl}`);
  console.log(`SIIGO_CLIENT_ID: ${mask(env.siigo.clientId)}`);
  console.log(`SIIGO_CLIENT_SECRET: ${mask(env.siigo.clientSecret)}`);
  console.log(`HUBSPOT_API_BASE_URL: ${env.hubspot.apiBaseUrl}`);
  console.log(`HUBSPOT_ACCESS_TOKEN: ${mask(env.hubspot.accessToken)}`);

  console.log('\n[1/3] Validando autenticacion Siigo...');
  const siigoToken = await getSiigoAccessToken(env, opts);
  console.log(`[OK] Siigo auth correcto. access_token recibido (${siigoToken.length} caracteres).`);

  console.log('\n[2/3] Validando permiso de facturas en Siigo...');
  const invoices = await getOpenInvoices(env, siigoToken, opts);
  console.log(`[OK] Siigo invoices accesible. Facturas abiertas detectadas: ${invoices.length}.`);
  if (env.testOnlyNit) {
    const countForNit = invoices.filter((i) => i.nit === env.testOnlyNit).length;
    console.log(`[INFO] TEST_ONLY_NIT=${env.testOnlyNit} -> facturas para ese NIT: ${countForNit}.`);
  }

  console.log('\n[3/3] Validando token HubSpot...');
  const hsUrl = `${env.hubspot.apiBaseUrl}/crm/v3/objects/companies?limit=1`;
  const hsRes = await get<unknown>(hsUrl, {
    headers: { Authorization: `Bearer ${env.hubspot.accessToken}` },
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
  });
  if (!hsRes.ok) {
    throw new SyncError(`HubSpot token invalido o sin permisos (HTTP ${hsRes.status})`, 'HUBSPOT_DIAG_ERROR', hsRes.data);
  }
  console.log('[OK] HubSpot token valido con acceso a companies.');

  console.log('\nResultado final: TODO OK. Credenciales listas para pruebas.');
}

async function main(): Promise<void> {
  try {
    await diagnose();
    process.exit(0);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('\n[ERROR] Configuracion invalida:', err.message);
      process.exit(2);
    }
    if (err instanceof SyncError) {
      console.error(`\n[ERROR] ${err.code}:`, err.message);
      if (err.cause) console.error(err.cause);
      process.exit(1);
    }
    console.error('\n[ERROR] Error inesperado:', err);
    process.exit(1);
  }
}

main();

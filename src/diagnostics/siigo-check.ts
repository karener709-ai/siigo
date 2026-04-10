import { getEnvSiigoOnly } from '../config/env.js';
import { getSiigoAccessToken } from '../siigo/auth.js';
import { getOpenInvoices } from '../siigo/invoices.js';
import { ConfigError, SyncError } from '../Core/errors.js';

function shortText(value: string, max = 120): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

async function runSiigoCheck(): Promise<void> {
  const env = getEnvSiigoOnly();
  const opts = { timeoutMs: env.httpTimeoutMs, retries: env.httpRetries };

  console.log('=== Diagnostico Siigo (solo lectura) ===');
  console.log(`SIIGO_AUTH_URL: ${env.siigo.authUrl}`);
  console.log(`SIIGO_API_BASE_URL: ${env.siigo.apiBaseUrl}`);
  console.log(`SIIGO_PARTNER_ID: ${env.siigo.partnerId}`);
  console.log(
    `SIIGO_INVOICES_MAX_PAGES: ${env.siigoInvoicesMaxPages == null ? '(todas las paginas)' : String(env.siigoInvoicesMaxPages)}`
  );
  console.log(`TEST_ONLY_NIT: ${env.testOnlyNit ?? '(no definido)'}${env.testOnlyNit ? ' (filtro customer_identification en API)' : ''}`);
  console.log(
    `TEST_ONLY_NITS: ${env.testOnlyNits.length > 0 ? env.testOnlyNits.join(', ') : '(no definido)'}`
  );

  console.log('\n[1/3] Probando autenticacion Siigo...');
  const token = await getSiigoAccessToken(env, opts);
  console.log(`[OK] Autenticacion correcta. Token recibido (${token.length} caracteres).`);

  console.log('\n[2/3] Consultando facturas abiertas...');
  const invoices = await getOpenInvoices(env, token, opts);
  console.log(`[OK] Consulta correcta. Facturas abiertas normalizadas: ${invoices.length}.`);

  const selectedNits = new Set([...(env.testOnlyNit ? [env.testOnlyNit] : []), ...env.testOnlyNits]);
  const filtered = selectedNits.size > 0 ? invoices.filter((i) => selectedNits.has(i.nit)) : invoices;
  if (selectedNits.size > 0) {
    console.log(`[INFO] Facturas para NITs seleccionados (${[...selectedNits].join(', ')}): ${filtered.length}.`);
  }

  console.log('\n[3/3] Validando datos requeridos por el backend...');
  let validRows = 0;
  let invalidRows = 0;
  for (const i of filtered) {
    const hasRequired =
      i.nit.trim() !== '' &&
      Number.isFinite(i.year) &&
      i.invoice_number.trim() !== '' &&
      Number.isFinite(i.balance) &&
      i.date.trim() !== '';
    if (hasRequired) validRows++;
    else invalidRows++;
  }

  console.log(`[OK] Filas validas: ${validRows}`);
  console.log(`[OK] Filas invalidas: ${invalidRows}`);

  const uniqueNits = new Set(filtered.map((i) => i.nit));
  console.log(`[INFO] Empresas (NIT) detectadas: ${uniqueNits.size}`);

  if (filtered.length > 0) {
    const sample = filtered[0]!;
    console.log('\nMuestra del dato (campos que usa el backend):');
    console.log(`- nit: ${sample.nit}`);
    console.log(`- year: ${sample.year}`);
    console.log(`- invoice_number: ${sample.invoice_number}`);
    console.log(`- balance: ${sample.balance}`);
    console.log(`- cost_center: ${shortText(sample.cost_center)}`);
    console.log(`- date: ${sample.date}`);
  } else {
    console.log('\n[INFO] No hay facturas para mostrar muestra en este momento.');
  }

  console.log('\nResultado final: Siigo responde y trae los campos necesarios para el backend.');
}

async function main(): Promise<void> {
  try {
    await runSiigoCheck();
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
    const message = err instanceof Error ? err.message : String(err);
    console.error('\n[ERROR] Error inesperado:', message);
    process.exit(1);
  }
}

main();

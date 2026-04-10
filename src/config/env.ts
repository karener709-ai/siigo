import 'dotenv/config';
import { z } from 'zod';
import { ConfigError } from '../Core/errors.js';

/** Siigo exige Partner-Id alfanumérico 3-100, sin espacios ni caracteres especiales. */
const siigoPartnerIdSchema = z
  .string()
  .optional()
  .refine(
    (v) => {
      if (v === undefined || v.trim() === '') return true;
      return /^[a-zA-Z0-9]{3,100}$/.test(v.trim());
    },
    {
      message:
        'SIIGO_PARTNER_ID inválido: use solo letras y números, entre 3 y 100 caracteres, sin guiones ni espacios (ej: fedesoftcarterasiigo)',
    }
  );

const envSchema = z.object({
  APP_MODE: z.enum(['sync', 'scheduler', 'worker']).optional().default('sync'),
  SIIGO_AUTH_URL: z.string().url('SIIGO_AUTH_URL debe ser una URL válida'),
  SIIGO_API_BASE_URL: z.string().url('SIIGO_API_BASE_URL debe ser una URL válida'),
  SIIGO_CLIENT_ID: z.string().min(1, 'SIIGO_CLIENT_ID es obligatorio'),
  SIIGO_CLIENT_SECRET: z.string().min(1, 'SIIGO_CLIENT_SECRET es obligatorio'),
  SIIGO_PARTNER_ID: siigoPartnerIdSchema,
  HUBSPOT_ACCESS_TOKEN: z.string().min(1, 'HUBSPOT_ACCESS_TOKEN es obligatorio'),
  HUBSPOT_API_BASE_URL: z.string().url().optional().default('https://api.hubapi.com'),
  HTTP_TIMEOUT_MS: z.string().optional(),
  HTTP_RETRIES: z.string().optional(),
  /** Si está definido, el sync se ejecuta en bucle cada N minutos (modo “siempre activo”). Si no, se ejecuta una vez y termina. */
  SYNC_INTERVAL_MINUTES: z.string().optional(),
  /** Si está definido, solo procesa este NIT (prueba controlada). */
  TEST_ONLY_NIT: z.string().optional(),
  /** Lista de NITs separada por comas para prueba controlada múltiple. */
  TEST_ONLY_NITS: z.string().optional(),
  /** Si está en true, no escribe en HubSpot (simulación segura). */
  SYNC_DRY_RUN: z.string().optional(),
  /** Máx. páginas al listar facturas Siigo (`GET /invoices`). Vacío = todas (sync completo). `1` = sólo primera (pruebas rápidas). */
  SIIGO_INVOICES_MAX_PAGES: z.string().optional(),
  /** Nombre interno en HubSpot del select "Seguimiento de afiliación" (enumeration). */
  HUBSPOT_SEGUIMIENTO_AFILIACION_PROPERTY: z.string().optional(),
  /** Valor interno de la opción cuando hay saldo en cartera (ej. mora). Debe coincidir con HubSpot. */
  HUBSPOT_SEGUIMIENTO_AFILIACION_MORA: z.string().optional(),
  /** Valor interno cuando no hay saldo (al día). */
  HUBSPOT_SEGUIMIENTO_AFILIACION_AL_DIA: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  WORKER_POLL_MS: z.string().optional(),
  WORKER_MAX_ATTEMPTS: z.string().optional(),
  WORKER_RETRY_DELAY_MS: z.string().optional(),
  SCHEDULER_BATCH_LIMIT: z.string().optional(),
});

export type Env = {
  appMode: 'sync' | 'scheduler' | 'worker';
  siigo: {
    authUrl: string;
    apiBaseUrl: string;
    clientId: string;
    clientSecret: string;
    partnerId: string;
  };
  hubspot: {
    apiBaseUrl: string;
    accessToken: string;
    /** Select único en HubSpot: mora vs al día según saldo total cartera. */
    seguimientoAfiliacion: {
      propertyName: string;
      valueMora: string;
      valueAlDia: string;
    } | null;
  };
  httpTimeoutMs: number;
  httpRetries: number;
  /** Minutos entre ejecuciones (0 = solo una vez y salir) */
  syncIntervalMinutes: number;
  /** NIT único para prueba controlada (null = todos) */
  testOnlyNit: string | null;
  /** Lista de NITs para prueba controlada múltiple (vacía = todos) */
  testOnlyNits: string[];
  /** Si true, no actualiza HubSpot; solo simula */
  syncDryRun: boolean;
  /** null = todas las páginas de facturas; número = como mucho esa cantidad de páginas */
  siigoInvoicesMaxPages: number | null;
  databaseUrl: string | null;
  workerPollMs: number;
  workerMaxAttempts: number;
  workerRetryDelayMs: number;
  schedulerBatchLimit: number | null;
};

let cached: Env | null = null;

function parseSiigoInvoicesMaxPages(raw: string | undefined): number | null {
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(50_000, Math.floor(n));
}

function parseTestOnlyNits(raw: string | undefined): string[] {
  if (raw == null || raw.trim() === '') return [];
  return [...new Set(raw.split(',').map((v) => v.trim()).filter(Boolean))];
}

function parsePositiveInt(raw: string | undefined, fallback: number, max = 86_400_000): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function parseNullablePositiveInt(raw: string | undefined, max = 1_000_000): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.floor(n), max);
}

const siigoOnlySchema = z.object({
  SIIGO_AUTH_URL: z.string().url('SIIGO_AUTH_URL debe ser una URL válida'),
  SIIGO_API_BASE_URL: z.string().url('SIIGO_API_BASE_URL debe ser una URL válida'),
  SIIGO_CLIENT_ID: z.string().min(1, 'SIIGO_CLIENT_ID es obligatorio'),
  SIIGO_CLIENT_SECRET: z.string().min(1, 'SIIGO_CLIENT_SECRET es obligatorio'),
  SIIGO_PARTNER_ID: siigoPartnerIdSchema,
  HTTP_TIMEOUT_MS: z.string().optional(),
  HTTP_RETRIES: z.string().optional(),
  TEST_ONLY_NIT: z.string().optional(),
  TEST_ONLY_NITS: z.string().optional(),
  SIIGO_INVOICES_MAX_PAGES: z.string().optional(),
});

/**
 * Solo variables Siigo + HTTP (para diagnósticos que no usan HubSpot).
 * HubSpot en el objeto queda con valores placeholder que no se deben usar.
 */
export function getEnvSiigoOnly(): Env {
  const parsed = siigoOnlySchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Variables Siigo inválidas o faltantes:\n${issues}`);
  }
  const raw = parsed.data;
  const partnerId = raw.SIIGO_PARTNER_ID?.trim() ? raw.SIIGO_PARTNER_ID.trim() : 'fedesoftcarterasiigo';
  return {
    appMode: 'sync',
    siigo: {
      authUrl: raw.SIIGO_AUTH_URL,
      apiBaseUrl: raw.SIIGO_API_BASE_URL.replace(/\/$/, ''),
      clientId: raw.SIIGO_CLIENT_ID,
      clientSecret: raw.SIIGO_CLIENT_SECRET,
      partnerId,
    },
    hubspot: {
      apiBaseUrl: 'https://api.hubapi.com',
      accessToken: 'not-used-siigo-only-diagnostic',
      seguimientoAfiliacion: null,
    },
    httpTimeoutMs: raw.HTTP_TIMEOUT_MS ? Number(raw.HTTP_TIMEOUT_MS) : 30_000,
    httpRetries: raw.HTTP_RETRIES ? Math.min(10, Math.max(1, Number(raw.HTTP_RETRIES))) : 3,
    syncIntervalMinutes: 0,
    testOnlyNit: raw.TEST_ONLY_NIT?.trim() ? raw.TEST_ONLY_NIT.trim() : null,
    testOnlyNits: parseTestOnlyNits(raw.TEST_ONLY_NITS),
    syncDryRun: false,
    siigoInvoicesMaxPages: parseSiigoInvoicesMaxPages(raw.SIIGO_INVOICES_MAX_PAGES),
    databaseUrl: null,
    workerPollMs: 5_000,
    workerMaxAttempts: 3,
    workerRetryDelayMs: 30_000,
    schedulerBatchLimit: null,
  };
}

function parseSeguimientoAfiliacion(raw: z.infer<typeof envSchema>): Env['hubspot']['seguimientoAfiliacion'] {
  const prop = raw.HUBSPOT_SEGUIMIENTO_AFILIACION_PROPERTY?.trim() ?? '';
  const mora = raw.HUBSPOT_SEGUIMIENTO_AFILIACION_MORA?.trim() ?? '';
  const alDia = raw.HUBSPOT_SEGUIMIENTO_AFILIACION_AL_DIA?.trim() ?? '';
  if (prop === '') return null;
  if (mora === '' || alDia === '') {
    throw new ConfigError(
      'Si define HUBSPOT_SEGUIMIENTO_AFILIACION_PROPERTY, debe definir también HUBSPOT_SEGUIMIENTO_AFILIACION_MORA y HUBSPOT_SEGUIMIENTO_AFILIACION_AL_DIA (valores internos de las opciones en HubSpot).'
    );
  }
  return { propertyName: prop, valueMora: mora, valueAlDia: alDia };
}

/** Carga y valida variables de entorno; lanza ConfigError si algo falla. Se cachea tras la primera llamada. */
export function getEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Variables de entorno inválidas o faltantes:\n${issues}`);
  }

  const raw = parsed.data;
  cached = {
    appMode: raw.APP_MODE,
    siigo: {
      authUrl: raw.SIIGO_AUTH_URL,
      apiBaseUrl: raw.SIIGO_API_BASE_URL.replace(/\/$/, ''),
      clientId: raw.SIIGO_CLIENT_ID,
      clientSecret: raw.SIIGO_CLIENT_SECRET,
      partnerId: raw.SIIGO_PARTNER_ID?.trim() ? raw.SIIGO_PARTNER_ID.trim() : 'fedesoftcarterasiigo',
    },
    hubspot: {
      apiBaseUrl: raw.HUBSPOT_API_BASE_URL.replace(/\/$/, ''),
      accessToken: raw.HUBSPOT_ACCESS_TOKEN,
      seguimientoAfiliacion: parseSeguimientoAfiliacion(raw),
    },
    httpTimeoutMs: raw.HTTP_TIMEOUT_MS ? Number(raw.HTTP_TIMEOUT_MS) : 30_000,
    httpRetries: raw.HTTP_RETRIES ? Math.min(10, Math.max(1, Number(raw.HTTP_RETRIES))) : 3,
    syncIntervalMinutes: raw.SYNC_INTERVAL_MINUTES ? Math.max(1, Number(raw.SYNC_INTERVAL_MINUTES)) : 0,
    testOnlyNit: raw.TEST_ONLY_NIT?.trim() ? raw.TEST_ONLY_NIT.trim() : null,
    testOnlyNits: parseTestOnlyNits(raw.TEST_ONLY_NITS),
    syncDryRun: String(raw.SYNC_DRY_RUN ?? '').trim().toLowerCase() === 'true',
    siigoInvoicesMaxPages: parseSiigoInvoicesMaxPages(raw.SIIGO_INVOICES_MAX_PAGES),
    databaseUrl: raw.DATABASE_URL?.trim() ? raw.DATABASE_URL.trim() : null,
    workerPollMs: parsePositiveInt(raw.WORKER_POLL_MS, 5_000),
    workerMaxAttempts: parsePositiveInt(raw.WORKER_MAX_ATTEMPTS, 3, 100),
    workerRetryDelayMs: parsePositiveInt(raw.WORKER_RETRY_DELAY_MS, 30_000),
    schedulerBatchLimit: parseNullablePositiveInt(raw.SCHEDULER_BATCH_LIMIT, 1_000_000),
  };
  return cached;
}

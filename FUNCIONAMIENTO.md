# Cómo funciona el sync Siigo → HubSpot

Este documento describe **qué hace** el proyecto, **qué datos usa** y **cómo ejecutarlo**.

---

## 1. Objetivo

Sincronizar la **cartera por cobrar** (facturas abiertas) desde **Siigo** hacia **HubSpot**: por cada empresa (identificada por NIT) se agrupan los saldos y números de factura por año (2023, 2024, 2025, 2026) y se actualizan las propiedades de la empresa en HubSpot.

---

## 2. Flujo (paso a paso)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  1. Cargar variables de entorno (.env) y validarlas (Zod)               │
└─────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  2. Siigo – Autenticación                                                │
│     POST SIIGO_AUTH_URL con client_credentials → access_token            │
└─────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  3. Siigo – Facturas abiertas                                           │
│     GET {SIIGO_API_BASE_URL}/invoices (Bearer token)                    │
│     → Solo facturas con balance > 0, normalizadas (nit, año, saldo…)    │
└─────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  4. Mapeo (por NIT)                                                     │
│     Agrupar por NIT y año:                                              │
│     - cartera_2023 / numero_de_factura_2023 (año ≤ 2023)                 │
│     - cartera_2024 / numero_de_factura_2024                              │
│     - saldo_2025 / numero_de_factura (nombres en HubSpot para 2025)         │
│     - cartera_2026 / numero_de_factura_2026                                │
│     - centro_de_costo (lista única)                                     │
└─────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  5. HubSpot – Por cada NIT                                              │
│     a) Buscar company por propiedad "nit2" = NIT                        │
│     b) Si existe → PATCH company con las propiedades de cartera         │
│     c) Si no existe → se cuenta como "skipped" (no se crea empresa)     │
└─────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  6. Salida                                                              │
│     "Sync OK. Actualizadas: X, Sin empresa en HubSpot: Y"               │
│     Código de salida: 0 = OK, 1 = error sync, 2 = config/env inválida  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2.1 Modo servidor recomendado

Para operación continua en servidor ahora se recomienda:

1. `scheduler` crea una corrida y encola un job por NIT.
2. `worker` toma jobs pendientes uno por uno.
3. Cada job consulta Siigo solo para ese NIT.
4. El resultado se registra en PostgreSQL.
5. HubSpot se actualiza solo cuando el job termina bien.

Tablas principales:

- `sync_runs`
- `sync_jobs`
- `sync_job_results`
- `sync_company_state`

Esto evita depender de una sola corrida masiva para decidir si una empresa queda en mora, al día o debe limpiarse.

---

## 3. Variables de entorno

Todas las credenciales y URLs se leen de **variables de entorno**. No hay archivo `config.json` con secretos.

| Variable | Obligatoria | Descripción | Ejemplo |
|----------|-------------|-------------|---------|
| `SIIGO_AUTH_URL` | Sí | URL de autenticación OAuth de Siigo | `https://api.siigo.com/auth` |
| `SIIGO_API_BASE_URL` | Sí | URL base de la API de Siigo | `https://api.siigo.com/v1` |
| `SIIGO_CLIENT_ID` | Sí | Client ID de la app en Siigo | (valor que te da Siigo) |
| `SIIGO_CLIENT_SECRET` | Sí | Client secret de la app en Siigo | (valor que te da Siigo) |
| `HUBSPOT_ACCESS_TOKEN` | Sí | Token de API privada de HubSpot | (desde HubSpot → Configuración → API) |
| `HUBSPOT_API_BASE_URL` | No | URL base de HubSpot (por defecto `https://api.hubapi.com`) | `https://api.hubapi.com` |
| `HTTP_TIMEOUT_MS` | No | Timeout en ms para peticiones HTTP (por defecto 30000) | `30000` |
| `HTTP_RETRIES` | No | Reintentos en fallos 429/5xx (por defecto 3) | `3` |
| `SYNC_INTERVAL_MINUTES` | No | Si está definido, el proceso corre en bucle y hace sync cada N minutos (“siempre activo”). Si no, hace un solo sync y termina. | `360` (cada 6 h) |
| `TEST_ONLY_NIT` | No | Si está definido, procesa solo ese NIT (prueba controlada). | `900123456` |
| `SYNC_DRY_RUN` | No | Si es `true`, simula el proceso y no actualiza HubSpot. | `true` |
| `SIIGO_INVOICES_MAX_PAGES` | No | Máximo de páginas al listar facturas; `1` acelera pruebas. Sin definir = todas. | `1` |
| `TEST_ONLY_NITS` | No | Lista de NITs separada por comas para prueba controlada múltiple. | `8001,8002,8003` |
| `APP_MODE` | No | `sync`, `scheduler` o `worker`. | `scheduler` |
| `DATABASE_URL` | No | PostgreSQL para scheduler/worker. | `postgresql://postgres:postgres@postgres:5432/cartera_sync` |
| `WORKER_POLL_MS` | No | Poll del worker para buscar jobs. | `5000` |
| `WORKER_MAX_ATTEMPTS` | No | Reintentos máximos por job. | `3` |
| `WORKER_RETRY_DELAY_MS` | No | Espera antes de reintentar un job. | `30000` |
| `SCHEDULER_BATCH_LIMIT` | No | Límite opcional de NITs por corrida. | `1000` |

**Uso:** Copia `.env.example` a `.env` y rellena los valores. El archivo `.env` no se sube a git.

**Dejarlo activo sin tocar nada:** Pon en `.env` algo como `SYNC_INTERVAL_MINUTES=360` y ejecuta `docker compose up -d`. El contenedor quedará corriendo y hará el sync cada 6 horas (o el intervalo que elijas) sin que tengas que volver a ejecutar nada.

---

## 4. Datos que se leen y escriben

### Desde Siigo (entrada)

- **Facturas** (`/invoices`): por cada factura se usan:
  - `number`, `balance`, `issue_date`
  - `customer.identification` → NIT
  - `cost_center.name` → centro de costo  
  Se consideran líneas con **balance distinto de 0**: facturas con saldo **positivo** y abonos / **notas crédito** con saldo **negativo** en el mismo listado, para que el total por NIT y año refleje el neto (p. ej. factura + NC).

### Hacia HubSpot (salida)

Por cada empresa encontrada por NIT (`nit2`), se actualizan estas propiedades:

| Propiedad HubSpot | Origen |
|-------------------|--------|
| `cartera_2023` | Suma de saldos de facturas con año ≤ 2023 |
| `numero_de_factura_2023` | Números de factura concatenados (año ≤ 2023) |
| `cartera_2024` | Suma de saldos año 2024 |
| `numero_de_factura_2024` | Números de factura año 2024 |
| `saldo_2025` | Suma de saldos año 2025 |
| `numero_de_factura` | Números de factura año 2025 (propiedad en HubSpot sin sufijo de año) |
| `cartera_2026` | Suma de saldos año 2026 |
| `numero_de_factura_2026` | Números de factura año 2026 |
| `centro_de_costo` | Lista única de centros de costo, separados por coma |
| Seguimiento de afiliación (nombre en `.env`) | **Paso 1:** NIT con facturas abiertas en Siigo → datos y “mora” desde Siigo. **Paso 2 (sync completo, sin `TEST_ONLY_NIT`):** empresas que **aún tienen saldo** en HubSpot (`cartera_*` / `saldo_2025`) pero **no** aparecen en la lista de facturas abiertas de Siigo en esa corrida → se limpian montos (como Siigo sin deuda) y “al día”. Así solo quienes **debían y pagaron** (dejaron de salir en Siigo) pasan a al día. Si Siigo y HubSpot ya van sin saldo en cartera → no se toca. |

En HubSpot las empresas se identifican por la propiedad **`nit2`**; debe coincidir con el NIT que devuelve Siigo en `customer.identification`.

---

## 5. Cómo ejecutarlo

Requisito: **Node.js 18+**.

```bash
# Instalar dependencias
npm install

# Copiar plantilla de variables de entorno y editar .env
copy .env.example .env

# Compilar y ejecutar
npm run build
npm start
```

O en un solo paso:

```bash
npm run sync
```

El proceso lee `.env` automáticamente (gracias a `dotenv`). Si falta alguna variable obligatoria o es inválida, el programa termina con un mensaje claro y código de salida **2**.

---

## 6. Estructura del código (Node.js / TypeScript)

```
src/
  config/
    env.ts          → Carga .env, valida con Zod, exporta getEnv()
  Core/
    errors.ts       → SyncError, ConfigError, SiigoError, HubSpotError
    http.ts         → request/get/post/patch con reintentos y timeout
  db/
    index.ts        → Pool Postgres, esquema, corridas, jobs y estado
  scheduler/
    index.ts        → Crea corridas automáticas y jobs por NIT
  siigo/
    auth.ts         → getSiigoAccessToken(env, opts)
    cost-centers.ts → Resuelve id → nombre del centro de costo
    credit-notes.ts → Lee notas crédito y las aplica al año correcto
    invoices.ts     → getOpenInvoices(env, token, opts)
    types.ts        → NormalizedInvoice, esquemas Zod de la API Siigo
  hubspot/
    company.ts      → updateCompanyCartera(env, nit, data, opts)
  mapper/
    cartera.ts      → mapInvoicesToCarteraByNit(invoices) → Map<nit, CompanyCartera>
  Sync/
    service.ts      → computeCarteraForNit(), syncNit()
    runner.ts       → runSync() orquesta todo el flujo
  worker/
    index.ts        → Consume jobs y sincroniza NIT por NIT
  index.ts          → Punto de entrada: getEnv(), runSync(), códigos de salida
```

- **Nombres:** en inglés en código (env, auth, invoices, company, cartera, runner); comentarios y documentación en español donde tiene sentido.
- **Seguridad:** sin secretos en código; validación de config y de respuestas de API (Zod); reintentos solo en 429/5xx y timeouts.

---

## 7. Códigos de salida

| Código | Significado |
|--------|-------------|
| 0 | Sync completado correctamente |
| 1 | Error durante el sync (Siigo, HubSpot o actualización) |
| 2 | Configuración inválida (variables de entorno faltantes o incorrectas) |

Así puedes usar el script en cron o en un pipeline y actuar según el código de salida.

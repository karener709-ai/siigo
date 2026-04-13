# Fedesoft - Sincronizacion cartera Siigo -> HubSpot

Este proyecto toma las facturas abiertas de Siigo y actualiza la cartera en empresas de HubSpot, cruzando por NIT.

Esta guia esta escrita para personas sin experiencia tecnica.

## Que hace en palabras simples

- Lee facturas pendientes de cobro desde Siigo.
- Agrupa esas facturas por empresa (NIT).
- Busca esa empresa en HubSpot por la propiedad `nit2`.
- Actualiza campos de cartera en HubSpot.

## Antes de empezar (que necesitas)

Necesitas estas 2 cosas:

1. Acceso a Siigo con credenciales de API:
   - `SIIGO_CLIENT_ID`
   - `SIIGO_CLIENT_SECRET`
2. Acceso a HubSpot con token privado:
   - `HUBSPOT_ACCESS_TOKEN`

Ademas:

- Tener Docker Desktop instalado y funcionando.
- Estar en la carpeta del proyecto (`fedesoft-cartera-siigo`).

## Prueba segura con una sola empresa (recomendado primero)

Para evitar tocar muchas empresas por error, ahora puedes hacer una prueba controlada:

- `TEST_ONLY_NIT`: limita el proceso a un solo NIT.
- `SYNC_DRY_RUN=true`: simula todo, pero no escribe nada en HubSpot.

### Paso 1: crear el archivo .env

En PowerShell:

```powershell
Copy-Item .env.example .env
```

### Paso 2: completar variables obligatorias en `.env`

Debes llenar como minimo:

- `SIIGO_CLIENT_ID`
- `SIIGO_CLIENT_SECRET`
- `SIIGO_PARTNER_ID` (header obligatorio `Partner-Id` en Siigo)
- `HUBSPOT_ACCESS_TOKEN`

Puedes dejar estas URLs por defecto salvo que tu proveedor te haya dado otras:

- `SIIGO_AUTH_URL=https://api.siigo.com/auth`
- `SIIGO_API_BASE_URL=https://api.siigo.com/v1`
- `HUBSPOT_API_BASE_URL=https://api.hubapi.com`

### Paso 3: activar prueba segura

En el `.env` agrega algo como:

```env
TEST_ONLY_NIT=900123456
SYNC_DRY_RUN=true
```

Con eso:

- Solo procesa ese NIT.
- No actualiza HubSpot (solo muestra lo que haria).

### Paso 4: ejecutar prueba

```powershell
docker compose up -d
docker compose logs -f sync
```

Cuando confirmes que todo esta bien:

1. Deja el mismo `TEST_ONLY_NIT`.
2. Cambia `SYNC_DRY_RUN=false`.
3. Ejecuta de nuevo para hacer la primera actualizacion real de esa empresa.

Luego puedes quitar `TEST_ONLY_NIT` para procesar todas.

## Ejecucion normal (sin modo prueba)

Si ya validaste todo:

- Quita o comenta `TEST_ONLY_NIT`.
- Usa `SYNC_DRY_RUN=false`.

Para una sola ejecucion:

- No definas `SYNC_INTERVAL_MINUTES`.

Para ejecucion automatica cada cierto tiempo en el modo clasico:

```env
SYNC_INTERVAL_MINUTES=360
```

Y luego:

```powershell
docker compose up -d
```

## Modo servidor recomendado

Para produccion ahora existe una arquitectura mas confiable con:

- `postgres`: guarda corridas, jobs por NIT, errores y ultimo estado.
- `scheduler`: crea una corrida nueva cada cierto tiempo y encola trabajo.
- `worker`: procesa jobs uno por uno y actualiza HubSpot.

### Variables nuevas

- `APP_MODE`: `sync`, `scheduler` o `worker`.
- `DATABASE_URL`: conexion a PostgreSQL.
- `WORKER_POLL_MS`: cada cuanto el worker busca jobs.
- `WORKER_MAX_ATTEMPTS`: reintentos maximos por NIT.
- `WORKER_RETRY_DELAY_MS`: espera antes de reintentar un job fallido.
- `SCHEDULER_BATCH_LIMIT`: limite opcional de NITs por corrida.

### Ejecucion en Docker Compose

Con `.env` configurado, puedes dejar el servidor asi:

```powershell
docker compose up -d postgres scheduler worker
docker compose logs -f scheduler worker
```

El `docker-compose.yml` del repositorio programa el scheduler en **calendario**: lunes y miércoles, **desde las 05:00** hora `SCHEDULER_TIMEZONE` (por defecto Bogotá) **sin hora límite** ese día (una corrida por día). Para acotar el tramo, define `SCHEDULER_WINDOW_END_HOUR` y `SCHEDULER_WINDOW_END_MINUTE` en `.env`.

### Flujo del modo servidor

1. `scheduler` consulta los NIT de HubSpot (`nit2`).
2. Crea una corrida en Postgres.
3. Inserta un job por NIT.
4. `worker` toma un job pendiente.
5. Consulta Siigo solo para ese NIT.
6. Calcula cartera, notas crédito y centro de costo.
7. Actualiza HubSpot y registra el resultado.

## Comandos utiles

- Levantar servicio: `docker compose up -d`
- Levantar servidor completo: `docker compose up -d postgres scheduler worker`
- Ver logs en vivo: `docker compose logs -f sync`
- Ver logs del servidor: `docker compose logs -f scheduler worker`
- Parar servicio: `docker compose down`
- Rebuild de imagen: `docker compose build --no-cache`
- Diagnostico de credenciales (Node): `npm run diagnose`
- Diagnostico solo Siigo (Node): `npm run siigo:check`

## Diagnostico rapido de credenciales

Si quieres confirmar que los tokens/clientes son correctos antes del sync real:

```powershell
npm run diagnose
```

Este comando valida:

- Auth de Siigo (`client_id` + `client_secret`)
- Auth de Siigo con fallback para credenciales tipo `usuario_api` + `access_key`
- Acceso al endpoint de facturas de Siigo
- Validez/permisos del token de HubSpot para `companies`

Devuelve logs claros y codigo de salida:

- `0`: todo OK
- `1`: error de credenciales/permisos
- `2`: error de configuracion en `.env`

Si solo quieres probar Siigo (sin validar HubSpot):

`siigo:check` solo exige variables de Siigo (`SIIGO_*` y opcionalmente `SIIGO_PARTNER_ID`, `TEST_ONLY_NIT`). No necesitas `HUBSPOT_ACCESS_TOKEN` para esta prueba.

```powershell
npm run siigo:check
```

En Docker:

```powershell
docker compose run --rm --entrypoint node sync dist/diagnostics/siigo-check.js
```

## Variables de entorno

| Variable | Obligatoria | Para que sirve |
|----------|-------------|----------------|
| `SIIGO_AUTH_URL` | Si | URL de autenticacion Siigo |
| `SIIGO_API_BASE_URL` | Si | URL base API Siigo |
| `SIIGO_CLIENT_ID` | Si | ID de cliente de Siigo |
| `SIIGO_CLIENT_SECRET` | Si | Secreto del cliente de Siigo |
| `SIIGO_PARTNER_ID` | Recomendado | Nombre de tu app/empresa para header `Partner-Id` en Siigo |
| `SIIGO_INVOICES_MAX_PAGES` | No | Ej. `1` = solo primera pagina de facturas (pruebas). Sin definir = todas las paginas |
| `HUBSPOT_ACCESS_TOKEN` | Si | Token privado de HubSpot |
| `HUBSPOT_API_BASE_URL` | No | URL base HubSpot (default: `https://api.hubapi.com`) |
| `HTTP_TIMEOUT_MS` | No | Tiempo maximo por peticion (default 30000) |
| `HTTP_RETRIES` | No | Reintentos en fallos temporales (default 3) |
| `SYNC_INTERVAL_MINUTES` | No | Si se define, repite sync cada N minutos |
| `TEST_ONLY_NIT` | No | Limita el sync a un solo NIT |
| `TEST_ONLY_NITS` | No | Lista de NITs separada por comas para prueba controlada |
| `SYNC_DRY_RUN` | No | `true` simula sin actualizar HubSpot |
| `APP_MODE` | No | `sync`, `scheduler` o `worker` |
| `DATABASE_URL` | No | Requerida para `scheduler` y `worker` |
| `WORKER_POLL_MS` | No | Poll del worker en milisegundos |
| `WORKER_MAX_ATTEMPTS` | No | Reintentos maximos por job |
| `WORKER_RETRY_DELAY_MS` | No | Espera antes de reintentar un job |
| `SCHEDULER_BATCH_LIMIT` | No | Límite opcional de NITs por corrida |
| `SCHEDULER_DAYS_OF_WEEK` | No | Modo calendario: días `0`–`6` separados por comas (`0`=dom, `1`=lun, …, `6`=sáb). Ej. `1,3` = lunes y miércoles. Si se define, sustituye al intervalo `SYNC_INTERVAL_MINUTES` en el scheduler |
| `SCHEDULER_TIMEZONE` | No | Zona IANA para la ventana (ej. `America/Bogota`). Por defecto `America/Bogota` |
| `SCHEDULER_WINDOW_START_HOUR` / `MINUTE` | No | Inicio local (por defecto 5:00) |
| `SCHEDULER_WINDOW_END_HOUR` / `MINUTE` | No | Fin exclusivo opcional; si ambos van vacíos, no hay tope (desde la hora de inicio hasta el fin del día) |
| `SCHEDULER_CALENDAR_POLL_SECONDS` | No | Cada cuántos segundos el scheduler comprueba el calendario (por defecto 60) |

## Que te puede faltar para que funcione completo

Aunque el proyecto corre, normalmente lo que falta en implementaciones reales es:

- Tener creadas en HubSpot las propiedades usadas por el sync:
  - `nit2`, `cartera_2023`, `numero_de_factura_2023`, `cartera_2024`, `numero_de_factura_2024`, `saldo_2025`, `numero_de_factura` (solo 2025), `cartera_2026`, `numero_de_factura_2026`, `centro_de_costo`
- Verificar que el NIT en HubSpot (`nit2`) tenga el mismo formato que Siigo (sin espacios ni caracteres extras).
- Confirmar permisos del token privado de HubSpot para leer y actualizar empresas.
- Validar en Siigo que las credenciales tengan acceso al endpoint de facturas.

## Códigos de salida

- `0`: sync correcto.
- `1`: error durante sync (Siigo o HubSpot).
- `2`: configuracion invalida.

## Documento tecnico adicional

Si quieres detalle tecnico del flujo, revisa `FUNCIONAMIENTO.md`.

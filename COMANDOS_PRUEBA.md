# Comandos y proceso para ejecutar una prueba

Trabaja desde la carpeta del proyecto (donde está `docker-compose.yml` y tu `.env`).

```powershell
cd c:\Users\USER\Documents\git\fedesoft-cartera-siigo
```

Si usas otra ruta, cambia solo la primera línea.

---

## 1. Revisar el `.env` antes de probar

- Credenciales **Siigo** (`SIIGO_*`) y **`SIIGO_PARTNER_ID`** (alfanumérico, sin espacios raros).
- **`HUBSPOT_ACCESS_TOKEN`**: token de **Private App** con permisos sobre **empresas (companies)**.
- **Prueba con una sola empresa** (recomendado):
  - `TEST_ONLY_NIT=<mismo valor que nit2 en HubSpot>`
  - Opcional: `SIIGO_INVOICES_MAX_PAGES=1` (más rápido; si no ves facturas de ese NIT, sube el número o comenta la variable).
- **Primera pasada sin tocar HubSpot** (opcional):
  - `SYNC_DRY_RUN=true`
- Para **escribir de verdad en HubSpot**: quita `SYNC_DRY_RUN` o pon `SYNC_DRY_RUN=false`.
- **Seguimiento de afiliación** (select en empresas): si quieres **mora** cuando hay saldo de cartera y **al día** cuando la suma es 0, define en `.env` (las tres o ninguna):
  - `HUBSPOT_SEGUIMIENTO_AFILIACION_PROPERTY` = nombre **interno** de la propiedad en HubSpot (p. ej. `seguimiento_de_afiliacion`).
  - `HUBSPOT_SEGUIMIENTO_AFILIACION_MORA` y `HUBSPOT_SEGUIMIENTO_AFILIACION_AL_DIA` = **valor interno** de cada opción del desplegable (en la configuración de la propiedad en HubSpot suele mostrarse como valor/código; no siempre coincide con el texto visible “En mora” / “Afiliado al día”). Si el PATCH falla por valor inválido, revisa esos strings en HubSpot.

Copia base: `.env.example`.

---

## 2. Validar credenciales (Siigo + HubSpot)

Reconstruye la imagen si cambiaste código TypeScript:

```powershell
docker compose build sync
```

Diagnóstico completo:

```powershell
docker compose run --rm --entrypoint node sync dist/diagnostics/verify-credentials.js
```

Debe terminar con **TODO OK** y **HubSpot token valido con acceso a companies**.

Solo Siigo (sin token HubSpot obligatorio en la validación principal de ese script; el archivo usa `getEnvSiigoOnly` en `siigo-check`):

```powershell
docker compose run --rm --entrypoint node sync dist/diagnostics/siigo-check.js
```

---

## 3. Ejecutar la prueba de sincronización

Una corrida y el contenedor termina:

```powershell
docker compose build sync
docker compose run --rm sync
```

### Qué mirar en la salida

- `Modo una sola empresa: NIT ...` → está activo `TEST_ONLY_NIT`.
- `SYNC_DRY_RUN=true` → no se escribe en HubSpot; solo verás `[DRY RUN]` con los datos.
- **`[OK] HubSpot: empresa actualizada... nit2 es exactamente "..."`** → se aplicó el PATCH a esa empresa.
- **`[SALTADO] HubSpot: no hay empresa con nit2="..."`** → en HubSpot no existe empresa con ese `nit2` exacto.
- `Sync OK. Actualizadas: X, Sin empresa en HubSpot: Y` → resumen (en dry run, “skipped” puede incluir simulaciones).

En HubSpot: CRM → Empresas → buscar por **`nit2`** y revisar propiedades de cartera y facturas.

---

## 4. Pasar de prueba a sync completo

En `.env`:

- Quita o comenta **`TEST_ONLY_NIT`**.
- Quita **`SYNC_DRY_RUN`** o déjalo en `false`.
- Para traer **todas** las páginas de facturas Siigo, quita o comenta **`SIIGO_INVOICES_MAX_PAGES`**.

Luego:

```powershell
docker compose build sync
docker compose run --rm sync
```

Para dejar el proceso **cada X minutos** (contenedor en marcha):

- Define `SYNC_INTERVAL_MINUTES=360` (o el valor que quieras).
- `docker compose up -d` (según tu flujo; el servicio `sync` usa el `.env`).

---

## 4.1 Modo servidor con scheduler + worker

Si quieres dejar el proceso productivo con Postgres y jobs por NIT:

En `.env`:

- `DATABASE_URL=postgresql://postgres:postgres@postgres:5432/cartera_sync`
- `SYNC_INTERVAL_MINUTES=360`
- `APP_MODE` no hace falta en `.env` si usas `docker compose`, porque cada servicio lo define.

Levanta los servicios:

```powershell
docker compose up -d postgres scheduler worker
docker compose logs -f scheduler worker
```

Qué hace:

- `scheduler` crea corridas y encola NITs.
- `worker` procesa los NIT uno por uno.
- Postgres guarda el estado de cada corrida y cada job.

---

## 5. Si cambias código y no ves el efecto

Siempre reconstruye la imagen antes de probar:

```powershell
docker compose build sync
```

---

## Referencia rápida (misma carpeta del proyecto)

| Objetivo              | Comando |
|-----------------------|---------|
| Build                 | `docker compose build sync` |
| Sync una vez          | `docker compose run --rm sync` |
| Diagnóstico credenciales | `docker compose run --rm --entrypoint node sync dist/diagnostics/verify-credentials.js` |
| Diagnóstico solo Siigo   | `docker compose run --rm --entrypoint node sync dist/diagnostics/siigo-check.js` |

Si ejecutas desde otra carpeta, usa la ruta completa al archivo compose, por ejemplo:

```powershell
docker compose -f "c:\Users\USER\Documents\git\fedesoft-cartera-siigo\docker-compose.yml" run --rm sync
```

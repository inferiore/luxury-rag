# 07 — Configuración de CORS en el backend

## Estado
Implementado

Validado: 2026-08-27 — PASS 8/8 criterios. Ver `rag/specs/validations/07-cors-configuration.validation.md`.

**Confirmado por Eder (2026-08-27):** el origen de producción queda pendiente para una spec futura de deployment del frontend. Por ahora `CORS_ORIGINS` cubre solo desarrollo local (`http://localhost:5173`), tal como propone esta spec.

## Contexto y objetivo

Al probar el flujo real en navegador (no solo `curl`), `react-rag-frontend` encontró que el backend NestJS (`rag/src/main.ts`) nunca llama a `app.enableCors()`. El navegador bloquea todas las peticiones cross-origin del frontend (`http://localhost:5173`, Vite) hacia el backend (`http://localhost:3000`) por política CORS — confirmado con error de preflight en consola y `OPTIONS /documents/upload` devolviendo 404 (NestJS no tiene una ruta `OPTIONS` propia; sin CORS habilitado el navegador ni siquiera llega a ejecutar la petición real).

Esta spec es pequeña y acotada a propósito: agrega únicamente configuración de CORS en el bootstrap de Nest. No modifica los contratos de request/response de `POST /documents/upload` (spec 02) ni de `POST /query` (spec 04), ni el esquema de datos — por eso no se redacta como `02-...-v2.md` ni `04-...-v2.md`; es una spec nueva, ortogonal, que toca el mismo archivo (`main.ts`, creado originalmente en la spec 02) pero no altera ninguno de los criterios de aceptación ya validados de esas specs. Esos criterios siguen vigentes tal cual.

El fix debe ser configurable por entorno, no un origen hardcodeado, porque existen (al menos) dos entornos con orígenes distintos:
- **Desarrollo local**: frontend Vite en `http://localhost:5173`, backend en `http://localhost:3000` (o dockerizado con hot reload, spec 05).
- **Producción**: el backend ya está dockerizado (`rag/docker-compose.yml`, spec 05, servicio `app`), pero **ninguna spec existente (00, 05, 06) define todavía dónde ni cómo se sirve el frontend en producción** — no hay servicio `frontend` en `docker-compose.yml`, ni dominio/subdominio asignado (ej. algo como `rag.luxuryhorizon.lat`), ni spec de "build + deploy del frontend". La spec 06 solo cubre `npm run dev` local.

### Pregunta abierta para Eder (bloqueante solo para el valor de producción, no para el fix en sí)

¿Cuál va a ser el origen (dominio/puerto) desde el que se sirva el frontend en producción? Sin esa respuesta, esta spec deja `CORS_ORIGINS` configurable vía `.env` con un default que **solo cubre desarrollo local** (`http://localhost:5173`); el valor de producción queda como placeholder documentado hasta que exista una spec de deployment del frontend (o Eder confirme el dominio) — no se asume ni se hardcodea un dominio de producción sin esa confirmación.

Dado que el diseño técnico es de bajo riesgo y no toca contratos ya validados, esta spec puede aprobarse sin una ronda adicional de revisión sobre su diseño — pero, siguiendo la regla del proyecto, **no se marca `Aprobado` hasta que Eder lo confirme explícitamente en la conversación**, y en particular hasta que Eder responda la pregunta del origen de producción (o acepte explícitamente dejarlo pendiente para una spec futura de deployment del frontend).

## Diseño técnico

- Nueva variable de entorno `CORS_ORIGINS` (string, lista separada por comas de orígenes permitidos, sin espacios extra requeridos — se hace `trim()` de cada valor). Se agrega a la validación de env existente (`@nestjs/config`, spec 02) como opcional con default `http://localhost:5173`.
- `rag/src/main.ts` — antes de `app.listen(...)`, se agrega:

```ts
const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.enableCors({
  origin: corsOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
});
```

- `origin: corsOrigins` (array) hace que Nest/`cors` valide el header `Origin` de la petición contra la lista y solo refleje `Access-Control-Allow-Origin` cuando hay match exacto — así, múltiples entornos (dev, producción, y cualquier entorno adicional que Eder agregue, ej. staging) conviven en la misma lista sin hardcodear un único valor fijo en el código.
- Peticiones **sin** header `Origin` (ej. `curl` directo, el healthcheck de Docker en `docker-compose.yml` spec 05, llamadas servidor-a-servidor) no son afectadas por esta configuración — CORS es una restricción que el navegador aplica del lado del cliente; `GET /health` y cualquier `curl` manual siguen respondiendo igual que hoy.
- No se habilitan credenciales (`credentials: true`) — no aplica, no hay autenticación (spec 00: "Sin autenticación por ahora").
- `methods` se limita a los verbos que el backend realmente expone (`GET` para `/health`, `POST` para los dos endpoints públicos, `OPTIONS` para el preflight) — no se usa el default permisivo de la librería `cors` para mantener la superficie explícita.
- `rag/docker-compose.yml` (spec 05, servicio `app`): se agrega `CORS_ORIGINS: ${CORS_ORIGINS:-http://localhost:5173}` a la sección `environment`, siguiendo el mismo patrón que las demás variables ya presentes ahí.
- `rag/.env.example`: se agrega la variable con comentario explicando el caso de desarrollo y dejando el caso de producción como placeholder comentado, sin inventar un dominio:

```bash
# --- CORS ---
# Lista de orígenes permitidos, separados por coma, sin espacios extra.
# Dev local (Vite, spec 06): http://localhost:5173
# Producción: pendiente de definir — no hay todavía spec de deployment del
# frontend ni dominio asignado. Agregar aquí el origen real (ej.
# https://rag.luxuryhorizon.lat) cuando exista, separado por coma del valor
# de dev si ambos deben convivir en el mismo .env.
CORS_ORIGINS=http://localhost:5173
```

## Contratos de API

Esta spec no agrega ni modifica endpoints ni sus bodies de request/response (esos siguen definidos en `02-upload-y-chunking-job.md` y `04-query-endpoint.md`). Solo agrega headers de respuesta CORS a los endpoints existentes. Ejemplo de la petición que hoy falla y debe empezar a funcionar:

**Preflight (lo que hoy responde 404 y debe responder 204):**
```
OPTIONS /documents/upload HTTP/1.1
Host: localhost:3000
Origin: http://localhost:5173
Access-Control-Request-Method: POST
Access-Control-Request-Headers: Content-Type
```

**Respuesta esperada tras esta spec:**
```
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: http://localhost:5173
Access-Control-Allow-Methods: GET,POST,OPTIONS
```

**Petición real de `/query` desde el frontend (debe incluir el header reflejado, no ser bloqueada):**
```
POST /query HTTP/1.1
Host: localhost:3000
Origin: http://localhost:5173
Content-Type: application/json

{"question": "precio de Guatapé"}
```
```
HTTP/1.1 200 OK
Access-Control-Allow-Origin: http://localhost:5173
Content-Type: application/json

{"matched": true, "answer": "..."}
```

## Esquema de datos

N/A — no crea ni modifica tablas.

## Criterios de aceptación

1. Con el backend corriendo localmente (`CORS_ORIGINS=http://localhost:5173` sin sobreescribir, valor default), `curl -i -X OPTIONS http://localhost:3000/query -H "Origin: http://localhost:5173" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: Content-Type"` responde HTTP 204 (o 200) e incluye el header `Access-Control-Allow-Origin: http://localhost:5173`.
2. El mismo preflight contra `OPTIONS /documents/upload` responde HTTP 204/200 con `Access-Control-Allow-Origin: http://localhost:5173` — ya no HTTP 404 (regresión directa del bug reportado).
3. `curl -i -X POST http://localhost:3000/query -H "Origin: http://localhost:5173" -H "Content-Type: application/json" -d '{"question":"precio de Guatapé"}'` responde HTTP 200 (o 200/404 según el contrato de la spec 04 para "sin coincidencia", pero nunca bloqueada por CORS) e incluye el header `Access-Control-Allow-Origin: http://localhost:5173` en la respuesta.
4. La misma petición del punto 3 pero con `-H "Origin: http://evil-example.com"` responde sin el header `Access-Control-Allow-Origin` (o con un valor que no coincide con `evil-example.com`) — confirma que la lista blanca no refleja cualquier origen.
5. `curl -i http://localhost:3000/health` (sin header `Origin`, simulando el healthcheck de Docker) sigue respondiendo HTTP 200 exactamente igual que antes de esta spec — no hay regresión en llamadas sin `Origin`.
6. Los criterios de aceptación ya validados de las specs 02, 04 y 05 (`documents/upload`, `/query`, `docker compose up` con healthcheck) se vuelven a correr y siguen pasando sin cambios en sus bodies/status codes — esta spec solo agrega headers, no altera comportamiento funcional.
7. `rag/.env.example` y `rag/docker-compose.yml` incluyen `CORS_ORIGINS` documentada tal como se describe en "Diseño técnico", sin un dominio de producción inventado.
8. Revisión de código: `CORS_ORIGINS` se lee desde configuración/env (no hay ningún string de origen hardcodeado directamente en `main.ts` fuera del default de desarrollo documentado).

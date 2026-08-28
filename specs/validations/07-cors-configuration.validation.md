# Validación — 07-cors-configuration

Fecha: 2026-08-27
Veredicto general: PASS (8/8 criterios)

## Infraestructura usada

- `rag-app` y `rag-postgres` levantados vía `docker compose -f rag/docker-compose.yml up -d` (ya estaban corriendo al iniciar la validación; se corrió además `docker compose build` para confirmar que la imagen compila sin errores con el estado actual del código). Ambos en estado `healthy` (`docker compose ps`) durante toda la validación.
- `.env` local **sin** `CORS_ORIGINS` seteada explícitamente — se usó a propósito para confirmar que el default (`http://localhost:5173`, tanto el de `main.ts`/`env.validation.ts` como el de `docker-compose.yml: CORS_ORIGINS: ${CORS_ORIGINS:-http://localhost:5173}`) es el que realmente aplica en runtime, tal como exige el criterio 1 ("sin sobreescribir, valor default").
- Todas las peticiones HTTP son `curl` reales contra `http://localhost:3000` (contenedor Docker), no mockeadas.
- Fixture no destructivo para el criterio 6 (regresión spec 02): un tour ficticio `tour-qa-cors.json` (`nombre: "Tour QA CORS Regresión"`) subido vía `POST /documents/upload`, inspeccionado con `psql`, y **borrado** (`DELETE` en `job_status`, `chunks`, `documents`) al finalizar — confirmado que `documents` volvió a su conteo original (10 filas) antes/después.
- No se tocó ningún dato real del catálogo (`chunks`/`documents` preexistentes) fuera de lecturas `SELECT`.

---

## Criterio 1: `OPTIONS /query` con Origin permitido → 204/200 con `Access-Control-Allow-Origin: http://localhost:5173`

**Resultado:** PASS
**Comando:**
```
curl -s -i -X OPTIONS http://localhost:3000/query \
  -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type"
```
**Evidencia:**
```
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: http://localhost:5173
Vary: Origin
Access-Control-Allow-Methods: GET,POST,OPTIONS
Access-Control-Allow-Headers: Content-Type
Content-Length: 0
```

## Criterio 2: `OPTIONS /documents/upload` con Origin permitido → 204/200 con el header (ya no 404)

**Resultado:** PASS
**Comando:**
```
curl -s -i -X OPTIONS http://localhost:3000/documents/upload \
  -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type"
```
**Evidencia:**
```
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: http://localhost:5173
Vary: Origin
Access-Control-Allow-Methods: GET,POST,OPTIONS
Access-Control-Allow-Headers: Content-Type
Content-Length: 0
```
No hay HTTP 404 — regresión directa del bug reportado en el contexto de la spec, resuelta.

## Criterio 3: `POST /query` con Origin permitido → 200 con `Access-Control-Allow-Origin` en la respuesta real

**Resultado:** PASS
**Comando:**
```
curl -s -i -X POST http://localhost:3000/query \
  -H "Origin: http://localhost:5173" \
  -H "Content-Type: application/json" \
  -d '{"question":"precio de Guatapé"}'
```
**Evidencia:**
```
HTTP/1.1 200 OK
Access-Control-Allow-Origin: http://localhost:5173
Vary: Origin
Content-Type: application/json; charset=utf-8

{"answer":"funcion call : datos no encontrados","matched":true}
```
El header CORS está presente en la petición real (no solo en el preflight), tal como exige el criterio. **Observación no bloqueante, fuera del alcance de esta spec:** el contenido de `answer` para esta pregunta concreta ("funcion call : datos no encontrados") parece un artefacto del LLM (posible salida de function-calling mal parseada) — no es un problema de CORS (la capa CORS solo agrega headers, no toca el body) ni está cubierto por los criterios de esta spec. Se repitió la misma pregunta sin `Origin` (ver regresión spec 04 abajo) y devolvió una respuesta limpia con el precio real, confirmando que es un comportamiento no determinista del LLM y no algo introducido por el cambio de CORS. Se documenta para que `nestjs-rag-developer`/`react-rag-frontend` lo evalúen si vuelve a aparecer, pero no bloquea esta spec.

## Criterio 4: Misma petición con `Origin: http://evil-example.com` → sin `Access-Control-Allow-Origin` (o valor no coincidente)

**Resultado:** PASS
**Comando:**
```
curl -s -i -X POST http://localhost:3000/query \
  -H "Origin: http://evil-example.com" \
  -H "Content-Type: application/json" \
  -d '{"question":"precio de Guatapé"}'
```
**Evidencia:**
```
HTTP/1.1 200 OK
Vary: Origin
Content-Type: application/json; charset=utf-8

{"answer":"El precio del tour Guatapé + Peñol es de **180.000 COP / 45 USD**. ...","matched":true}
```
No aparece el header `Access-Control-Allow-Origin` en ningún lugar de la respuesta — confirma que la lista blanca (`origin: corsOrigins`) no refleja `evil-example.com`. La petición sigue respondiendo 200 vía `curl` (CORS es una restricción del navegador, no del servidor), pero un navegador real bloquearía la lectura de esta respuesta por la ausencia del header.

## Criterio 5: `GET /health` sin `Origin` sigue respondiendo 200 igual que antes

**Resultado:** PASS
**Comando:**
```
curl -s -i http://localhost:3000/health
```
**Evidencia:**
```
HTTP/1.1 200 OK
Vary: Origin
Content-Type: application/json; charset=utf-8

{"status":"ok"}
```
Status 200 y body `{"status":"ok"}` sin cambios. Único efecto lateral observado: el header `Vary: Origin` aparece en **todas** las respuestas (con o sin `Origin` en el request) porque el middleware `cors` lo agrega siempre por diseño de la librería — es un header informativo para cachés, no afecta el comportamiento funcional ni bloquea nada; no contradice el criterio ("responde 200 exactamente igual" se interpreta sobre status/body, que no cambian).

## Criterio 6: Regresión — criterios ya validados de specs 02, 04 y 05 siguen pasando

**Resultado:** PASS
**Comandos y evidencia (resumen; ver detalle completo en la sección de comandos ejecutados abajo):**

- **Spec 05** — `docker compose build` (sin errores), `docker compose ps` → `app` y `postgres` `healthy`, `curl http://localhost:3000/health` → 200 desde el host, `POST /query` real (`{"question":"¿Cuánto cuesta el tour a Guatapé?"}`) → `200 {"answer":"El tour a Guatapé + Peñol cuesta 180000 COP / 45 USD.","matched":true}` (respuesta limpia, confirma que `OLLAMA_BASE_URL=http://host.docker.internal:11434` sigue alcanzando Ollama del host).
- **Spec 02** — subida de fixture no destructivo (`tour-qa-cors.json`, 1 tour) → `202 {"documentId":"64c5a7ca-...","totalItems":1,"status":"processing"}`; `chunks` con 1 fila `document_id` correcto, `content` de 201 caracteres, legible (nombre/descripción/precio); `job_status` con fila `chunking: done`; `documents.status = "processing"` justo tras el 202. Casos de error: JSON inválido → `400 {"message":"El archivo no contiene JSON válido",...}` sin nuevas filas en `documents` (`11`→`11`); item sin `nombre` → `400` identificando `index:1, field:"nombre"`; sin campo `file` → `400 {"message":"El campo 'file' es requerido",...}`. Fixture borrado al final (`documents` vuelve a 10 filas).
- **Spec 04** — `{"question": "¿Cuál es la capital de Francia?"}` → `200 {"answer":"datos no encontrados","matched":false}`; `question` vacío → `400 {"message":["question no puede estar vacío"],...}`; `question` ausente (`{}`) → `400` con ambos mensajes de validación.

Todos los status codes y bodies coinciden exactamente con lo documentado en `specs/validations/02-upload-y-chunking-job.validation.md` y `specs/validations/04-query-endpoint.validation.md` — el único cambio observable en las respuestas es la presencia del header `Vary: Origin` (efecto secundario esperado y documentado de habilitar CORS), sin alteración de status codes ni bodies.

## Criterio 7: `.env.example` y `docker-compose.yml` documentan `CORS_ORIGINS` sin dominio de producción inventado

**Resultado:** PASS
**Comando:**
```
grep -A7 "CORS" .env.example
grep -n "CORS_ORIGINS" docker-compose.yml
```
**Evidencia:**
```
# --- CORS ---
# Lista de orígenes permitidos, separados por coma, sin espacios extra.
# Dev local (Vite, spec 06): http://localhost:5173
# Producción: pendiente de definir — no hay todavía spec de deployment del
# frontend ni dominio asignado. Agregar aquí el origen real (ej.
# https://rag.luxuryhorizon.lat) cuando exista, separado por coma del valor
# de dev si ambos deben convivir en el mismo .env.
CORS_ORIGINS=http://localhost:5173

CORS_ORIGINS: ${CORS_ORIGINS:-http://localhost:5173}
```
`https://rag.luxuryhorizon.lat` aparece solo como ejemplo explícito de placeholder dentro de un comentario ("ej. ..."), no como valor real ni default activo — coincide con lo pactado en la sección "Pregunta abierta" de la spec (origen de producción pendiente, confirmado por Eder).

## Criterio 8: Revisión de código — `CORS_ORIGINS` se lee desde env, sin string de origen hardcodeado fuera del default de dev documentado

**Resultado:** PASS
**Comando:**
```
grep -rn "localhost:5173\|enableCors\|CORS_ORIGINS" src/
```
**Evidencia:**
```
src/main.ts:14:  const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
src/main.ts:19:  app.enableCors({
src/config/env.validation.ts:37:  CORS_ORIGINS: Joi.string().default('http://localhost:5173'),
```
El único literal `http://localhost:5173` en todo `src/` aparece exactamente dos veces: como fallback del `??` en `main.ts` (documentado en el diseño técnico de la spec) y como `.default()` de Joi en `env.validation.ts` (mismo valor, consistente). No hay ningún otro origen hardcodeado en el código fuente.

---

## Verificación adicional: fix de `tsconfig.json`/`tsconfig.build.json` (prerequisito no relacionado, reportado por `nestjs-rag-developer`)

Se verificó de forma independiente que el bug es real, preexistente (no introducido por los cambios de CORS) y que el fix es necesario y correcto:

**Reproducción del bug (revirtiendo temporalmente el fix):**
```
# tsconfig.json: exclude: ["node_modules", "dist"]           (sin "frontend")
# tsconfig.build.json: exclude: ["node_modules", "test", "dist", "**/*spec.ts"]  (sin "frontend")
npm run build
```
**Evidencia:**
```
frontend/src/main.tsx:4:17 - error TS5097: An import path can only end with a '.tsx' extension...
frontend/src/main.tsx:16:3 - error TS17004: Cannot use JSX unless the '--jsx' flag is provided.
...
Found 66 error(s).
```
Reproduce exactamente el número de errores (66) reportado por `nestjs-rag-developer`, confirmando que el bug es real y no exagerado.

**Verificación de que el fix (ambos `exclude` incluyen `"frontend"`) lo resuelve:**
```
npm run build
```
**Evidencia:**
```
> rag@0.0.1 build
> nest build

EXIT CODE: 0
```
Archivos restaurados exactamente al estado del fix (confirmado con `diff` contra backup en el scratchpad — sin diferencias).

**Nota sobre el alcance real del fix:** `docker compose build` (ver Dockerfile) **no** depende de este fix — el `Dockerfile` solo hace `COPY src ./src` (nunca copia `frontend/` al contexto de build de la imagen), así que `nest build` dentro de Docker nunca intentó compilar `frontend/`, con o sin el fix. El fix es necesario específicamente para **desarrollo local en el host** (`npm run build`, `npm run start:dev`, y por extensión `npm run lint`/`npm test` si dependieran de una compilación limpia), donde `frontend/` sí convive en el mismo árbol de archivos que `src/`. Esto no contradice el reporte de `nestjs-rag-developer` — solo acota dónde aplica.

**No rompe nada:** `npm run build` (exit 0), `npm run lint` (`0 errors, 10 warnings` — mismos warnings preexistentes de `*.spec.ts`), `npm test` (`43 passed, 43 total`), y `docker compose build` + `docker compose ps` (`app`/`postgres` healthy) se verificaron todos con el fix aplicado, sin regresiones.

---

## Verificaciones adicionales de build/calidad

- `docker compose build` → sin errores, imagen `rag-app` construida/cacheada correctamente.
- `npm run build` (host, con el fix de tsconfig aplicado) → exit 0.
- `npm run lint` → `10 problems (0 errors, 10 warnings)` — mismos warnings preexistentes de `@typescript-eslint/no-unsafe-argument` en `*.spec.ts`, no relacionados con CORS ni con `main.ts`.
- `npm test` → `Test Suites: 10 passed, 10 total` / `Tests: 43 passed, 43 total`.
- `docker compose logs app --tail 80` tras todas las pruebas → sin errores ni excepciones relevantes.

## Conclusión

Los 8 criterios de aceptación de `07-cors-configuration.md` se verificaron con evidencia real: `curl` directo contra el backend dockerizado (`rag-app`, `healthy`), inspección de código fuente, y regresión activa (no solo re-lectura de reportes previos) de los criterios relevantes de las specs 02, 04 y 05 — todos siguen pasando sin cambios en status codes ni bodies, con el único efecto lateral esperado del header `Vary: Origin` en todas las respuestas. El fix de `tsconfig.json`/`tsconfig.build.json` reportado como prerequisito se confirmó real (reproducido el bug de 66 errores revirtiéndolo temporalmente), necesario para builds en el host, y sin romper nada dockerizado ni en tests.

El sistema quedó en estado limpio al finalizar: fixture de prueba (`tour-qa-cors.json` y su documento/chunks/job_status asociados) eliminado, `documents` de vuelta a su conteo original (10 filas), `tsconfig.json`/`tsconfig.build.json` verificados idénticos al estado entregado por el implementador, `.env` sin modificar, contenedores Docker (`rag-app`, `rag-postgres`) siguen `healthy`.

Se sugiere a Eder que `rag-spec-planner` actualice el `Estado` de `rag/specs/07-cors-configuration.md` de `Aprobado` a `Implementado`.

SPEC_STATUS: 07-cors-configuration PASS

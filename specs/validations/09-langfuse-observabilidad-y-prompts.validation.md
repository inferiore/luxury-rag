# Validación — 09-langfuse-observabilidad-y-prompts

Fecha: 2026-08-28 (validación inicial) — **Re-validación: 2026-08-28**
Veredicto general: **PASS (19/19 criterios)**

---

## Re-validación (2026-08-28) — resumen ejecutivo

La validación inicial (conservada íntegra más abajo) encontró 5/19 criterios en FAIL (1, 6, 7, 8, y consecuencias en el resto de la evidencia end-to-end), con dos causas raíz:

1. `rag/src/config/env.validation.ts` tenía `.default('https://cloud.langfuse.com')` en el schema Joi de `LANGFUSE_HOST`. NestJS `ConfigModule` escribía ese default en `process.env.LANGFUSE_HOST` **antes** de que `configuration.ts` evaluara su propia cadena `??`, neutralizando el alias `LANGFUSE_BASE_URL` en toda ejecución real.
2. `rag/scripts/seed-langfuse-prompt.ts` no cargaba `.env` (`dotenv.config()` ausente), por lo que la invocación documentada (`npm run seed:langfuse-prompt` en shell limpia) corría con credenciales `undefined`, recibía 401 del SDK, y el `catch` interpretaba ese 401 como "el prompt no existe", reportando un falso "creado" sin haber creado nada.

`nestjs-rag-developer` corrigió ambas causas raíz:
- `env.validation.ts`: `LANGFUSE_HOST` ahora es `Joi.string().optional()` (sin `.default()`), con un comentario explicando por qué.
- `seed-langfuse-prompt.ts`: se agregó `import * as dotenv from 'dotenv'; dotenv.config();` al inicio.

Esta re-validación **no confía en el autoreporte del implementador** — se re-derivó evidencia propia para cada criterio afectado, se confirmó que las causas raíz efectivamente ya no reproducen, y se confirmó que los archivos tocados (`env.validation.ts`, `seed-langfuse-prompt.ts`) no afectan a ningún otro archivo relevante para los 14 criterios que ya habían pasado antes.

### Infraestructura usada en la re-validación

- `rag-postgres` y `rag-app` (Docker, ya corrientes, healthy) — **no se reiniciaron ni tocaron**.
- `nest start --watch` (proceso de desarrollo del propio Eder, PID 61339) — **no se tocó** en ningún momento.
- `npm run build` se corrió en el host (exit 0) y los criterios 1, 2, 3 se re-verificaron arrancando `dist/src/main.js` en background con distintas combinaciones de env vars, en puertos efímeros (3903-3905), matando cada proceso con `kill -9` al terminar. Confirmado sin huérfanos al final (`ps aux | grep dist/src/main.js` vacío).
- Para el criterio 3 en particular, se detectó que el `.env` real de Eder (gitignored, en `rag/.env`) tiene `LANGFUSE_BASE_URL="https://us.cloud.langfuse.com"` activa, y `ConfigModule.forRoot()` (sin `envFilePath` explícito) carga `.env` del cwd por default — así que arrancar el proceso desde `rag/` sin definir las variables en el shell **igual las hereda del `.env` real**, contaminando el escenario "ninguna definida". Se corrigió ejecutando ese caso puntual desde un cwd sin archivo `.env` (`/private/tmp/.../scratchpad/no-env-cwd/`), invocando `dist/src/main.js` por ruta absoluta — así sí se ejercita genuinamente la rama del default global.
- Para los criterios 6, 7 y 8 (script de seed): el prompt real `query-system-prompt` del proyecto de Langfuse de Eder ya existe (confirmado en la validación inicial y por el autoreporte del implementador), así que no se podía usar para simular "no existe" ni "difiere" sin arriesgar el prompt de producción. Técnica usada: **copias temporales del script real**, idénticas byte a byte salvo el nombre del prompt (`PROMPT_NAME = 'qa-validation-seed-test'` en vez de `'query-system-prompt'`), ejecutadas con las credenciales reales de `.env` contra el proyecto real de Langfuse Cloud de Eder (mismo host, mismas keys). Esto es representativo del comportamiento real porque ejercita el mismo SDK, la misma API HTTP de Langfuse (`getPrompt`/`createPrompt`), y la misma lógica de comparación — solo cambia el nombre del recurso para no tocar el prompt de producción. Los archivos temporales (`scripts/__qa-seed-test.ts`, `scripts/__qa-seed-diff-test.ts`, `scripts/__qa-verify.ts`) se borraron al terminar (`rm -f`, confirmado con `git status --short scripts/`).
- **Efecto secundario no destructivo:** queda creado en el proyecto real de Langfuse de Eder un prompt de prueba `qa-validation-seed-test` (v1, label `production`, texto = `SYSTEM_PROMPT` real). No se pudo/debió borrar vía el SDK (no expone un método de borrado de prompts); es un artefacto de QA inofensivo, claramente identificable por su nombre, que no interfiere con `query-system-prompt` (el único nombre que la app y el script real consultan). Eder puede borrarlo manualmente desde el dashboard de Langfuse si lo desea — no afecta ningún criterio ni el funcionamiento del sistema.
- `npm run build` y `npm test` se corrieron en el host tal cual, sin mocks ni flags especiales.

### Re-verificación criterios 1, 2, 3, 5 (resolución de host)

**Criterio 1** — antes FAIL, ahora **PASS**.
Comando:
```bash
PORT=3903 NODE_ENV=development \
POSTGRES_HOST=localhost POSTGRES_PORT=5432 POSTGRES_USER=rag_user POSTGRES_PASSWORD=changeme POSTGRES_DB=rag_db \
OLLAMA_BASE_URL=http://localhost:11434 \
LANGFUSE_PUBLIC_KEY=pk-lf-dummy LANGFUSE_SECRET_KEY=sk-lf-dummy \
LANGFUSE_BASE_URL=https://us.cloud.langfuse.com \
node dist/src/main.js   # LANGFUSE_HOST deliberadamente NO definida
```
Evidencia:
```
[Nest] 66842 - ... WARN [LangfuseService] Usando LANGFUSE_BASE_URL como alias deprecado de LANGFUSE_HOST (host resuelto: https://us.cloud.langfuse.com). Renombra la variable a LANGFUSE_HOST en tu .env cuando puedas.
[Nest] 66842 - ... LOG [LangfuseService] Cliente de Langfuse inicializado — host: https://us.cloud.langfuse.com
```
Ambas líneas exigidas por el criterio aparecen, con el host correcto (`https://us.cloud.langfuse.com`, no el default global). Esto confirma que la causa raíz A (default de Joi neutralizando el alias) ya no reproduce.

**Criterio 2** — ya era PASS, re-confirmado sin cambios.
```bash
PORT=3904 ... LANGFUSE_HOST=https://cloud.langfuse.com LANGFUSE_BASE_URL=https://us.cloud.langfuse.com node dist/src/main.js
```
```
[Nest] 66908 - ... LOG [LangfuseService] Cliente de Langfuse inicializado — host: https://cloud.langfuse.com
```
Sin línea `WARN`. Host resuelto = canónico. El fix de Joi no rompió este caso.

**Criterio 3** — ya era PASS "por accidente" en la validación inicial (por la misma causa raíz que rompía el criterio 1); re-verificado desde cero, esta vez asegurando que ninguna variable Langfuse quede definida (ni por shell ni heredada del `.env` real de Eder, que sí tiene `LANGFUSE_BASE_URL` activa):
```bash
mkdir -p .../scratchpad/no-env-cwd && cd .../scratchpad/no-env-cwd
PORT=3905 NODE_ENV=development \
POSTGRES_HOST=localhost POSTGRES_PORT=5432 POSTGRES_USER=rag_user POSTGRES_PASSWORD=changeme POSTGRES_DB=rag_db \
OLLAMA_BASE_URL=http://localhost:11434 \
LANGFUSE_PUBLIC_KEY=pk-lf-dummy LANGFUSE_SECRET_KEY=sk-lf-dummy \
node /Users/.../rag/dist/src/main.js
```
```
[Nest] 67085 - ... LOG [LangfuseService] Cliente de Langfuse inicializado — host: https://cloud.langfuse.com
```
Sin `WARN`. Host = default (`https://cloud.langfuse.com`), esta vez con la certeza de que la rama ejercitada es genuinamente la de "ninguna de las dos variables definida" (no una coincidencia del bug anterior). **PASS confirmado de forma más rigurosa que en la validación inicial.**

**Criterio 5** — revisión de código, sin cambios respecto a la validación inicial (el archivo `configuration.ts` no fue tocado por el fix):
```ts
host:
  process.env.LANGFUSE_HOST ??
  process.env.LANGFUSE_BASE_URL ??
  'https://cloud.langfuse.com',
```
PASS, ahora además confirmado que esta cadena **sí se ejercita de verdad en runtime** (antes era código muerto por la causa raíz A) — ver criterio 1.

### Re-verificación criterios 6, 7, 8 (script de seed)

**Técnica:** copia temporal `scripts/__qa-seed-test.ts` (idéntica a `seed-langfuse-prompt.ts` salvo `PROMPT_NAME = 'qa-validation-seed-test'`), ejecutada con `npx ts-node -r tsconfig-paths/register` y las credenciales reales de `.env` (ya con `dotenv.config()` presente, igual que el script real).

**Criterio 6** — antes FAIL, ahora **PASS**.
1ra corrida:
```
[Langfuse SDK] Error while fetching prompt 'qa-validation-seed-test-label:production': Error: Prompt not found: 'qa-validation-seed-test' with label 'production'
Prompt 'qa-validation-seed-test' creado en Langfuse (v1).
```
Nótese el error real es "Prompt not found" (404 genuino), no "Invalid authorization header" (401 de credenciales vacías) como en la validación inicial — confirma que esta vez sí se autenticó correctamente.
Verificación independiente contra el SDK (`client.getPrompt('qa-validation-seed-test', ...)`):
```
version: 1
labels: [ 'production', 'latest' ]
type: text
textMatchesSystemPrompt: true
```
Creación real confirmada: v1, `type: text`, `labels` incluye `production`, texto idéntico byte a byte a `SYSTEM_PROMPT`.

**Criterio 7** — antes FAIL, ahora **PASS**.
2da corrida del mismo script:
```
Prompt 'qa-validation-seed-test' ya existe y coincide — nada que hacer.
```
Verificación posterior: `version: 1` (sin cambios), confirma que no se creó una nueva versión ni se llamó a `createPrompt`.

**Criterio 8** — antes FAIL, ahora **PASS**.
Copia temporal `scripts/__qa-seed-diff-test.ts` (mismo `PROMPT_NAME`, pero compara/crearía con un texto local deliberadamente distinto: `LOCAL_PROMPT_TEXT = '[QA TEST — texto local deliberadamente distinto del remoto, criterio 8]'`), contra el prompt `qa-validation-seed-test` ya existente (texto real = `SYSTEM_PROMPT`):
```
El prompt 'qa-validation-seed-test' ya existe en Langfuse y su texto difiere de la constante SYSTEM_PROMPT actual en el código. NO se sobrescribe automáticamente — reconcilia manualmente en el dashboard de Langfuse o actualiza SYSTEM_PROMPT si el texto remoto es el correcto.
```
Verificación posterior de que no sobrescribió:
```
version: 1
textMatchesSystemPrompt: true
```
La versión remota sigue en 1 y el texto remoto sigue siendo el original — no hubo sobrescritura.

### Confirmación de no-regresión en los 14 criterios ya pasados (2, 4, 9-19)

- Los dos archivos tocados por el fix (`env.validation.ts`, `seed-langfuse-prompt.ts`) **no son importados ni referenciados** por `query.service.ts`, `query.service.spec.ts`, `langfuse.service.ts`, `langfuse.service.spec.ts`, `system-prompt.constant.ts`, `.env.example` ni `package.json` (más allá del propio script) — confirmado por `grep` cruzado, no hay ninguna dependencia nueva entre estos archivos.
- `npm run build` → exit 0.
- `npm test` → **`Test Suites: 11 passed, 11 total` / `Tests: 77 passed, 77 total`** (mismo conteo que la validación inicial, sin regresiones).
- `rag/.env.example` (criterio 4) y `rag/package.json` (criterio 9): releídos, contenido idéntico al ya validado.
- Criterio 16 (hash de `SYSTEM_PROMPT`): re-calculado — `sha256: cde27547ab3bd380798e3a827d42d56220e7482aab117110373c31c9cc30a31b`, idéntico al de la validación inicial.
- Criterios 18/19 (regresión end-to-end de spec 04): re-corridos contra `rag-app` real (sin reiniciar el contenedor):
  ```bash
  curl -s -i -X POST http://localhost:3000/query -d '{"question": "¿Cuánto cuesta el tour a Guatapé?"}'
  # HTTP/1.1 200 OK — {"answer":"El tour a Guatapé tiene un costo neto de $100.000 y un precio al público de $150.000.","matched":true}
  curl -s -i -X POST http://localhost:3000/query -d '{"question": "¿Cuál es la capital de Francia?"}'
  # HTTP/1.1 200 OK — {"answer":"datos no encontrados","matched":false}
  curl -s -i -X POST http://localhost:3000/query -d '{}'
  # HTTP/1.1 400 Bad Request — {"message":["question no puede estar vacío","question must be a string"],...}
  docker compose logs app --tail 20 | grep -iE "error|exception"
  # [Langfuse SDK] Error while fetching prompt 'query-system-prompt-label:production': Error: Invalid credentials...
  ```
  Sin excepciones NestJS ni 500 — el único "error" en logs es el SDK de Langfuse fallando su llamada de red (best-effort, no-fatal, contrato del criterio 9 de spec 04 preservado). **Nota:** el contenedor `rag-app` sigue mostrando "Invalid credentials" porque corre una imagen Docker construida antes de este fix y porque `docker-compose.yml` no reenvía `LANGFUSE_BASE_URL` al contenedor — esto es exactamente el comportamiento **ya documentado y aceptado como fuera de alcance** por la propia spec ("No se toca `docker-compose.yml`..."), no una regresión nueva. Para que el contenedor real de Eder resuelva el host correctamente necesitará `docker compose up -d --build` (fuera del alcance de esta validación de código) y, si quiere eliminar el alias por completo, renombrar la variable a `LANGFUSE_HOST` en su `.env`.
- Criterios 10-15, 17 (tests unitarios de `langfuse.service.spec.ts` / `query.service.spec.ts`): cubiertos por el mismo `npm test` en verde; los archivos fuente de esos tests no fueron tocados por el fix, por lo que la evidencia detallada de la validación inicial (líneas de código citadas, aserciones) sigue siendo válida sin necesidad de re-transcribirla.

### Limpieza post-validación

```bash
rm -f scripts/__qa-seed-test.ts scripts/__qa-seed-diff-test.ts scripts/__qa-verify.ts
ps aux | grep -E "dist/src/main.js|nest start" | grep -v grep
# ederbarrios ... nest start --watch   (único proceso — el de Eder, sin tocar)
docker compose ps
# rag-app y rag-postgres, mismos "Up X hours (healthy)" que al inicio
```
Sin procesos huérfanos. `nest start --watch` de Eder intacto. Contenedores Docker sin reiniciar.

---

## Conclusión de la re-validación

**19/19 criterios en PASS.** Las dos causas raíz reportadas por `nestjs-rag-developer` fueron confirmadas como efectivamente corregidas con evidencia propia y reproducible (no autoreporte):

1. `env.validation.ts` sin `.default()` en `LANGFUSE_HOST` → la cadena `??` de `configuration.ts` ahora se ejercita de verdad en runtime (criterios 1, 3 confirmados con las 4 combinaciones de env vars).
2. `seed-langfuse-prompt.ts` con `dotenv.config()` → el script ahora se autentica correctamente en su invocación documentada, y las tres ramas (crear / idempotente / advertir sin sobrescribir) fueron ejercitadas con Langfuse Cloud real (criterios 6, 7, 8).

Ningún criterio previamente en PASS sufrió regresión (`npm test` 77/77, hash de `SYSTEM_PROMPT` idéntico, `.env.example`/`package.json` sin cambios, curl end-to-end de spec 04 sin cambios de contrato).

**Se sugiere a `rag-spec-planner` actualizar el `Estado` de esta spec a `Implementado`.**

SPEC_STATUS: 09-langfuse-observabilidad-y-prompts PASS

---
---

# (Histórico) Validación inicial — 2026-08-28 — FAIL (14/19 criterios)

*Conservado sin modificar como registro histórico. Los criterios 1, 6, 7 y 8 documentados como FAIL abajo fueron corregidos y re-validados como PASS en la sección "Re-validación" de más arriba.*

## Infraestructura usada

- `rag-postgres` (docker, ya corriendo, healthy) y `rag-app` (docker, ya corriendo, healthy) — **ninguno de los dos fue reiniciado ni tocado** durante esta validación.
- Para los criterios que requieren arrancar la app con distintas combinaciones de env vars (`LANGFUSE_HOST`/`LANGFUSE_BASE_URL`, `SIMILARITY_THRESHOLD`, credenciales vacías), se usó el `dist/` ya compilado (`npm run build` previo, exit 0) ejecutado directamente con `node dist/src/main.js` en el host, en puertos distintos (3901-3909) apuntando al mismo Postgres (`localhost:5432`, publicado por el contenedor) y a Ollama real (`localhost:11434`). Cada proceso se lanzó en background, se esperó ~6s a que terminara el boot, se capturó el log/curl necesario, y se mató con `kill -9 <pid>` — confirmado sin huérfanos al final (`ps aux | grep dist/src/main.js` vacío en cada checkpoint).
- Para los criterios de Langfuse que requieren inspeccionar el contenido real de spans/generations (4-6 de spec 04, re-verificados en el criterio 19 de esta spec), se replicó el mismo mock HTTP no destructivo usado en la validación de `04-query-endpoint.md`: un servidor Python en `127.0.0.1:4318` que implementa `POST /api/public/ingestion` y persiste cada batch recibido a un `.jsonl`.
- Para los criterios 6-8 (script de seed), **sí había credenciales reales de Langfuse Cloud disponibles** (`rag/.env`, cluster `us.cloud.langfuse.com`) — se usaron para probar tanto la invocación literal documentada (`npm run seed:langfuse-prompt`) como, por separado, una invocación con las mismas credenciales exportadas manualmente al shell, para aislar si un eventual fallo era de lógica o de carga de configuración. Efecto secundario no destructivo: quedó creado en el proyecto real de Langfuse de Eder un prompt `query-system-prompt` v1 con el texto exacto de `SYSTEM_PROMPT` (esto es exactamente el resultado que la spec busca producir eventualmente, no un dato de prueba corrupto).
- Todos los archivos tocados (`.env`, `package.json`, `scripts/`) se dejaron sin modificar; solo se leyeron y se ejecutaron procesos efímeros fuera del repo.

---

## Hallazgo crítico (afecta criterios 1, 6, 7, 8): el fix de host NO funciona en la app real, y el script de seed NO se autentica en su invocación documentada

Antes de listar los 19 criterios, dos causas raíz que explican los 4 fallos:

**A. `env.validation.ts` neutraliza el fix de `configuration.ts`.** `rag/src/config/env.validation.ts` tiene:
```ts
LANGFUSE_HOST: Joi.string().default('https://cloud.langfuse.com'),
```
NestJS `ConfigModule.forRoot({ validationSchema })` valida `process.env` con este esquema y luego llama a `assignVariablesToProcess(validatedConfig)` — código de `@nestjs/config` (`node_modules/@nestjs/config/dist/config.module.js:198-212`) que **escribe en `process.env` cualquier clave del config validado que no estuviera ya presente en `process.env`**. Esto ocurre **antes** de que se invoque la factory `configuration()` (el `load` de `ConfigModule.forRoot` se resuelve después, línea 104-108 del mismo archivo). Como `LANGFUSE_HOST` nunca está en `process.env` cuando solo se define `LANGFUSE_BASE_URL`, Joi le inyecta su default `'https://cloud.langfuse.com'`, y ese valor se escribe en `process.env.LANGFUSE_HOST` — con lo cual, para cuando `configuration.ts` ejecuta `process.env.LANGFUSE_HOST ?? process.env.LANGFUSE_BASE_URL ?? '...'`, el primer operando **ya nunca es `undefined`**. Todo el mecanismo de alias deprecado es código muerto en la app real. Confirmado con evidencia de arranque real (criterio 1, abajo) y con una reproducción aislada de la validación de Joi (ver criterio 1).

**B. `scripts/seed-langfuse-prompt.ts` no carga `.env`.** A diferencia de `rag/src/database/data-source.ts` (que sí llama `dotenv.config()` explícitamente porque corre fuera del contexto de Nest — comentario propio del archivo lo dice), `seed-langfuse-prompt.ts` lee `process.env.LANGFUSE_PUBLIC_KEY`/`SECRET_KEY`/`HOST` directamente sin cargar `dotenv` primero. La convención de todo el proyecto (`.env.example`, `docker-compose.yml`, `data-source.ts`) es que las credenciales viven en `.env`, no exportadas manualmente en el shell. Ejecutar el comando exacto que documenta el criterio 6 (`npm run seed:langfuse-prompt`) en una sesión de shell limpia (sin `export LANGFUSE_*` previo, que es el estado real de cualquier terminal nueva) resulta en credenciales `undefined`, un `401 Unauthorized` del SDK, y — porque el script solo tiene `try { getPrompt } catch { existing = null }` — el script interpreta el 401 como "el prompt no existe" y ejecuta `createPrompt`. El SDK de Langfuse (`langfuse-core/lib/index.cjs.js:1758-1767`, método `fetchAndLogErrors`) **no lanza excepción en respuestas HTTP de error** — solo loguea y devuelve el cuerpo JSON del error como si fuera la respuesta exitosa. El resultado: el script imprime `Prompt 'query-system-prompt' creado en Langfuse (v1).` sin haber creado nada — un **falso positivo silencioso**, reproducido de forma idéntica dos veces seguidas (nunca llega a imprimir el mensaje de idempotencia).

---

## Criterio 1: Con `LANGFUSE_HOST` sin definir y `LANGFUSE_BASE_URL=https://us.cloud.langfuse.com` definida, al arrancar la app aparece warning de alias deprecado y log info con el host resuelto `https://us.cloud.langfuse.com`.

**Resultado:** FAIL *(corregido — ver "Re-validación" arriba: ahora PASS)*

**Comando:**
```bash
PORT=3903 NODE_ENV=development \
POSTGRES_HOST=localhost POSTGRES_PORT=5432 POSTGRES_USER=rag_user POSTGRES_PASSWORD=changeme POSTGRES_DB=rag_db \
OLLAMA_BASE_URL=http://localhost:11434 \
LANGFUSE_PUBLIC_KEY=pk-lf-ee4ff802-b68e-4000-8a71-83afa986a986 \
LANGFUSE_SECRET_KEY=sk-lf-d078fff8-a752-411c-a9d9-0e6ac9be5c21 \
LANGFUSE_BASE_URL=https://us.cloud.langfuse.com \
node dist/src/main.js
# (LANGFUSE_HOST deliberadamente NO definida)
```

**Evidencia:**
```
[Nest] 63357 - ... LOG [LangfuseService] Cliente de Langfuse inicializado — host: https://cloud.langfuse.com
[Nest] 63357 - ... LOG [InstanceLoader] LangfuseModule dependencies initialized +0ms
```
No aparece ningún log `WARN` mencionando `LANGFUSE_BASE_URL`. El host resuelto es `https://cloud.langfuse.com` (el default), **no** `https://us.cloud.langfuse.com` como exige el criterio, pese a que `LANGFUSE_BASE_URL` estaba definida y `LANGFUSE_HOST` no.

**Causa raíz aislada** (sin arrancar Nest, solo la validación de Joi que usa `ConfigModule`):
```bash
node -e "
const Joi = require('joi');
const schema = Joi.object({LANGFUSE_HOST: Joi.string().default('https://cloud.langfuse.com')}).unknown(true);
const config = {LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com', ...process.env};
delete config.LANGFUSE_HOST;
const {value} = schema.validate(config, {abortEarly:false, allowUnknown:true});
console.log('validatedConfig.LANGFUSE_HOST =', value.LANGFUSE_HOST);
"
```
```
validatedConfig.LANGFUSE_HOST = https://cloud.langfuse.com
```
Este valor default de Joi es el que `@nestjs/config` escribe en `process.env.LANGFUSE_HOST` antes de que `configuration.ts` lo lea (ver `node_modules/@nestjs/config/dist/config.module.js:198-212`, método `assignVariablesToProcess`, y el orden de llamada en `forRoot` líneas 90/99 vs. 104-108). El `??` de `configuration.ts` nunca llega a evaluar `LANGFUSE_BASE_URL`.

**Reproducción adicional:** el propio contenedor `rag-app` en producción, con el `.env` real de Eder (`LANGFUSE_BASE_URL=https://us.cloud.langfuse.com` activa, `LANGFUSE_HOST` comentada), muestra el mismo síntoma en sus logs reales:
```
docker compose logs app 2>&1 | grep -i langfuse
```
```
rag-app | ... LOG [LangfuseService] Cliente de Langfuse inicializado — host: https://cloud.langfuse.com
rag-app | [Langfuse SDK] Error while fetching prompt 'query-system-prompt-label:production': Error: Invalid credentials. Confirm that you've configured the correct host.
```
(El error de credenciales inválidas es consistente con que las API keys de Eder son del cluster `us`, pero el host resuelto sigue siendo el global — el bug original que esta spec debía arreglar sigue reproduciéndose end-to-end.)

Nota: en el caso del contenedor Docker hay además una segunda causa independiente — `docker-compose.yml` fija `LANGFUSE_HOST: ${LANGFUSE_HOST:-https://cloud.langfuse.com}` en el bloque `environment` y nunca reenvía `LANGFUSE_BASE_URL` al contenedor — pero esto es un comportamiento **ya documentado y aceptado explícitamente por la propia spec** ("No se toca `docker-compose.yml`... ya usan `LANGFUSE_HOST` como nombre canónico"), así que no se cuenta como fallo adicional del criterio; el fallo real y no documentado es el de Joi, que rompe incluso la ejecución directa (`node dist/src/main.js` / `npm run start:dev`) que es el escenario que este criterio describe literalmente.

## Criterio 2: Con `LANGFUSE_HOST` y `LANGFUSE_BASE_URL` definidas simultáneamente, gana el canónico y no aparece warning.

**Resultado:** PASS

**Comando:**
```bash
PORT=3904 ... LANGFUSE_HOST=https://cloud.langfuse.com LANGFUSE_BASE_URL=https://us.cloud.langfuse.com node dist/src/main.js
```
**Evidencia:**
```
[Nest] 63447 - ... LOG [LangfuseService] Cliente de Langfuse inicializado — host: https://cloud.langfuse.com
```
Sin línea `WARN` de alias deprecado. Host resuelto = canónico. Coincide con `langfuse.service.spec.ts` ("no loguea warning de alias deprecado cuando usingDeprecatedHostAlias es false").

## Criterio 3: Sin ninguna de las dos variables definidas, el host resuelto es el default, sin warning.

**Resultado:** PASS

**Comando:**
```bash
PORT=3905 ... (sin LANGFUSE_HOST ni LANGFUSE_BASE_URL) node dist/src/main.js
```
**Evidencia:**
```
[Nest] 63480 - ... LOG [LangfuseService] Cliente de Langfuse inicializado — host: https://cloud.langfuse.com
```
Sin warning. Host = default. (Nota: en este caso particular el resultado es correcto, pero por la misma razón estructural que rompe el criterio 1 — Joi ya inyecta ese mismo valor como default — no porque la cadena `??` de `configuration.ts` se haya ejercitado realmente con las tres ramas.)

## Criterio 4: `rag/.env.example` documenta `LANGFUSE_BASE_URL` como alias deprecado sin eliminar `LANGFUSE_HOST`.

**Resultado:** PASS

**Comando:** `Read rag/.env.example` (líneas 70-82)
**Evidencia:**
```bash
LANGFUSE_HOST=https://cloud.langfuse.com
# Alias DEPRECADO de LANGFUSE_HOST, soportado solo por compatibilidad hacia
# atrás (spec 09). Si defines LANGFUSE_HOST, este valor se ignora. No agregar
# variables nuevas usando este nombre — usa siempre LANGFUSE_HOST.
# LANGFUSE_BASE_URL=
```
`LANGFUSE_HOST` sigue presente como variable canónica activa; `LANGFUSE_BASE_URL` está documentada (comentada) como alias deprecado.

## Criterio 5: `configuration.ts` implementa exactamente la cadena `LANGFUSE_HOST ?? LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com'`.

**Resultado:** PASS (revisión de código pura, tal como pide el criterio)

**Comando:** `Read rag/src/config/configuration.ts`
**Evidencia:**
```ts
host:
  process.env.LANGFUSE_HOST ??
  process.env.LANGFUSE_BASE_URL ??
  'https://cloud.langfuse.com',
usingDeprecatedHostAlias:
  !process.env.LANGFUSE_HOST && !!process.env.LANGFUSE_BASE_URL,
```
El código implementa literalmente la cadena descrita. **Importante:** este criterio se cumple a nivel de código fuente, pero el criterio 1 demuestra que, en ejecución real, esta cadena es código muerto por la interacción con `env.validation.ts`. Ambos hechos son ciertos simultáneamente y se reportan por separado porque los criterios están redactados de forma independiente (uno es "revisión de código", el otro es comportamiento end-to-end).

## Criterio 6: `npm run seed:langfuse-prompt` contra un prompt inexistente lo crea vía `createPrompt` con texto idéntico a `SYSTEM_PROMPT`.

**Resultado:** FAIL *(corregido — ver "Re-validación" arriba: ahora PASS)*

**Comando (invocación literal del criterio, shell limpia, credenciales solo en `.env`):**
```bash
env | grep -i LANGFUSE   # (vacío — nada exportado en el shell)
npm run seed:langfuse-prompt
```
**Evidencia:**
```
Langfuse secret key was not passed to constructor or not set as 'LANGFUSE_SECRET_KEY' environment variable. No observability data will be sent to Langfuse.
[Langfuse SDK] Error while fetching prompt 'query-system-prompt-label:production': Error: Invalid authorization header
[Langfuse SDK] 401: Unauthorized. ... body: {"message":"Invalid authorization header","error":"UnauthorizedError"}
Prompt 'query-system-prompt' creado en Langfuse (v1).
```
El script reporta éxito (`creado en Langfuse (v1)`) pero las credenciales nunca se cargaron (mensaje del propio SDK confirmándolo) y la llamada de creación recibió un 401 que el script no detecta como error (ver "Hallazgo crítico B" arriba). Nada se creó realmente en este intento.

**Verificación de que la lógica de creación en sí es correcta**, cuando se fuerza autenticación real (exportando manualmente las mismas credenciales de `.env`, con el host correcto — bypaseando el bug B sin modificar el script):
```bash
export LANGFUSE_PUBLIC_KEY=pk-lf-ee4ff802-b68e-4000-8a71-83afa986a986
export LANGFUSE_SECRET_KEY=sk-lf-d078fff8-a752-411c-a9d9-0e6ac9be5c21
export LANGFUSE_HOST=https://us.cloud.langfuse.com
npm run seed:langfuse-prompt
# -> Prompt 'query-system-prompt' creado en Langfuse (v1).
node -e "... client.getPrompt('query-system-prompt', undefined, {label:'production', type:'text'}) ..."
# -> name: query-system-prompt / version: 1 / labels: [ 'production', 'latest' ] / type: text
# -> promptTextEqualsSystemPrompt: true
```
Con autenticación real, la creación es correcta (versión 1, label `production`, tipo `text`, texto byte-idéntico). Pero esto **no** es lo que produce la invocación documentada en el criterio (`npm run seed:langfuse-prompt` tal cual, sin exports manuales) — por eso se marca FAIL: el criterio pide verificar el resultado de ejecutar el comando documentado, y ese comando no logra autenticarse ni crear nada, solo lo aparenta.

## Criterio 7: Correr el script una segunda vez no crea una nueva versión ni llama a `createPrompt`.

**Resultado:** FAIL *(corregido — ver "Re-validación" arriba: ahora PASS)*

**Comando:** dos ejecuciones consecutivas de `npm run seed:langfuse-prompt`, shell limpia (mismo estado que criterio 6).
**Evidencia:**
```
--- 1ra corrida ---
[Langfuse SDK] 401: Unauthorized ...
Prompt 'query-system-prompt' creado en Langfuse (v1).
--- 2da corrida ---
[Langfuse SDK] 401: Unauthorized ...
Prompt 'query-system-prompt' creado en Langfuse (v1).
```
La segunda corrida **nunca imprime** el mensaje de idempotencia (`ya existe y coincide — nada que hacer`) — porque `getPrompt` sigue fallando con 401 en ambas corridas (nunca hay credenciales reales), así que el script cree siempre que el prompt no existe. No hay forma de observar idempotencia real con la invocación documentada.

Con autenticación forzada manualmente (mismo bypass que en criterio 6), sí se comportó de forma idempotente:
```bash
# (mismas credenciales exportadas que en criterio 6)
npm run seed:langfuse-prompt
# -> Prompt 'query-system-prompt' ya existe y coincide — nada que hacer.
node -e "... client.getPrompt(...) ..." # -> version after 2nd run: 1
```
La lógica de idempotencia en sí es correcta; la invocación documentada no la ejercita.

## Criterio 8: Si el texto remoto difiere, el script advierte y no sobrescribe.

**Resultado:** FAIL *(corregido — ver "Re-validación" arriba: ahora PASS)* (por la misma causa — con la invocación documentada nunca se llega a esa rama del código, porque `existing` siempre es `null` por el 401)

**Comando:** invocación documentada, sin exports manuales — no aplica directamente porque nunca hay un "remoto" real con el que comparar (ver arriba). Para no dejar el criterio sin verificar de ningún modo, se probó la rama de código en sí (no la invocación del criterio) con una copia idéntica del script salvo un `SYSTEM_PROMPT` local deliberadamente distinto, autenticando correctamente:
```bash
# scripts/__qa-seed-diff-test.ts (copia exacta de seed-langfuse-prompt.ts,
# SYSTEM_PROMPT reemplazado por un texto de prueba distinto — archivo temporal,
# borrado al terminar)
npx ts-node -r tsconfig-paths/register scripts/__qa-seed-diff-test.ts
```
**Evidencia:**
```
El prompt 'query-system-prompt' ya existe en Langfuse y su texto difiere de la constante SYSTEM_PROMPT actual en el código. NO se sobrescribe automáticamente — reconcilia manualmente en el dashboard de Langfuse o actualiza SYSTEM_PROMPT si el texto remoto es el correcto.
```
Verificación de que no sobrescribió el remoto:
```
version still: 1
text still matches original SYSTEM_PROMPT: true
```
La lógica de "no sobrescribir en caso de discrepancia" es correcta en aislamiento. Se marca FAIL porque, igual que 6 y 7, la invocación literalmente descrita en el criterio (`npm run seed:langfuse-prompt` sin exports manuales) nunca llega a esta rama en absoluto — siempre toma la rama de creación (falsa), nunca la de comparación.

## Criterio 9: `package.json` incluye `seed:langfuse-prompt` con el comando exacto, siguiendo el patrón de `typeorm`/`migration:*`.

**Resultado:** PASS

**Comando:** `grep -n "seed:langfuse\|typeorm\|migration:" rag/package.json`
**Evidencia:**
```
21:    "typeorm": "ts-node -r tsconfig-paths/register ./node_modules/typeorm/cli.js -d src/database/data-source.ts",
22:    "migration:run": "npm run typeorm -- migration:run",
25:    "seed:langfuse-prompt": "ts-node -r tsconfig-paths/register scripts/seed-langfuse-prompt.ts"
```
El texto del script coincide exactamente con el especificado en el diseño técnico. (El patrón de invocación coincide; la diferencia real de comportamiento frente a `typeorm` — que sí carga `dotenv` en `data-source.ts` — es lo que falla en los criterios 6-8, no en este criterio, que solo pide el string en `package.json`.)

## Criterio 10: Test unitario — `client === null` ⇒ `getSystemPrompt()` devuelve el fallback sin llamar a `getPrompt`.

**Resultado:** PASS

**Comando:** `npm test -- langfuse.service.spec.ts`
**Evidencia (test real, `langfuse.service.spec.ts:114-124`):**
```ts
it('devuelve el fallback local sin llamar a getPrompt si client es null (criterio 10)', async () => {
  const service = await buildService({ 'langfuse.publicKey': '', 'langfuse.secretKey': '' });
  const result = await service.getSystemPrompt();
  expect(result).toEqual({ text: SYSTEM_PROMPT, promptForTrace: null });
  expect(mockLangfuseClient.getPrompt).not.toHaveBeenCalled();
});
```
```
Test Suites: 1 passed
Tests: ... passed (incluye este caso)
```
El test efectivamente instancia el servicio con credenciales vacías (`client` queda `null` por el propio constructor) y espía que `getPrompt` nunca se invocó — prueba exactamente lo que dice.

## Criterio 11: Test unitario — con `client` mockeado y `getPrompt` resolviendo, `getSystemPrompt()` devuelve texto + `promptForTrace` no nulo.

**Resultado:** PASS

**Evidencia (`langfuse.service.spec.ts:126-149`):**
```ts
it('devuelve el texto y el promptForTrace del SDK cuando getPrompt resuelve (criterio 11)', async () => {
  const fakePrompt = { prompt: SYSTEM_PROMPT };
  mockLangfuseClient.getPrompt.mockResolvedValue(fakePrompt);
  ...
  expect(result.text).toBe(SYSTEM_PROMPT);
  expect(result.promptForTrace).toBe(fakePrompt);
  expect(mockLangfuseClient.getPrompt).toHaveBeenCalledWith('query-system-prompt', undefined,
    expect.objectContaining({ label: 'production', type: 'text', fallback: SYSTEM_PROMPT }));
});
```
Prueba real: mockea la respuesta del SDK y verifica tanto el valor devuelto como los argumentos exactos de la llamada (`label: 'production'`, `type: 'text'`, `fallback: SYSTEM_PROMPT`).

## Criterio 12: Test unitario — `getPrompt` rechaza ⇒ `getSystemPrompt()` no propaga, devuelve fallback.

**Resultado:** PASS

**Evidencia (`langfuse.service.spec.ts:151-166`):**
```ts
it('devuelve el fallback local sin propagar el error si getPrompt rechaza (criterio 12)', async () => {
  mockLangfuseClient.getPrompt.mockRejectedValue(new Error('Langfuse caído'));
  ...
  await expect(service.getSystemPrompt()).resolves.toEqual({ text: SYSTEM_PROMPT, promptForTrace: null });
});
```
Fuerza un rechazo real de la promesa mockeada y confirma que se resuelve (no rechaza) con el fallback — prueba genuinamente el camino de error.

## Criterio 13: `askChatModel` usa `text` de `getSystemPrompt()`, no `SYSTEM_PROMPT` directo.

**Resultado:** PASS

**Comando:** `Read rag/src/modules/query/query.service.ts` (líneas 94-99) + `npm test -- query.service.spec.ts`
**Evidencia:**
```ts
const { text: systemPromptText, promptForTrace } = await this.langfuseService.getSystemPrompt();
...
{ role: 'system' as const, content: systemPromptText },
```
Test dedicado (`query.service.spec.ts:145-163`) mockea `getSystemPrompt` devolviendo un texto distinto (`'Prompt versionado desde Langfuse'`) y confirma que ese es el texto que efectivamente llega a `ollamaProvider.chat`:
```ts
expect(ollamaProvider.chat).toHaveBeenCalledWith([
  { role: 'system', content: customPromptText },
  expect.objectContaining({ role: 'user' }),
]);
```
`npm test -- query.service.spec.ts` → todos los tests en verde.

## Criterio 14: `startSpan`/`endSpan` del chat reemplazados por `startGeneration`/`endGeneration` invocando `trace.generation({name:'chat', model, prompt, ...})`.

**Resultado:** PASS

**Comando:** revisión de código (`query.service.ts:107-113, 193-231`) + verificación empírica end-to-end vía mock de ingestión (mismo mock usado en criterio 19).
**Evidencia de código:**
```ts
const chatGeneration = this.startGeneration(trace, 'chat', {
  input: { messages }, model: chatModel, prompt: promptForTrace ?? undefined,
});
```
**Evidencia empírica real** (capturada del batch de ingestión enviado por la app corriendo contra el mock local, pregunta con match y `topK=3`):
```
generation-create - chat - input: {"messages": [{"role": "system", "content": "Eres mi asistente para la empresa luxury horizon..." ...
generation-update - None - ... output: {"answer": "El tour a Guatapé cuesta $150.000 al público."}
"model": "qwen3:8b"
```
Confirma con tráfico real (no solo mock/unit test) que la observación enviada es de tipo `generation-create` (no `span-create`) para el nombre `chat`, con el `model` correcto. El campo `prompt` no aparece en este batch concreto porque, contra el mock (que no implementa el endpoint GET de prompts), `getPrompt` falla y `promptForTrace` es `null` — comportamiento esperado y consistente con el diseño (`prompt: promptForTrace ?? undefined`).

## Criterio 15: Test unitario — `trace.generation` lanza ⇒ `askChatModel` no falla, responde igual.

**Resultado:** PASS

**Evidencia (`query.service.spec.ts:165-186`):**
```ts
it('no rompe /query si trace.generation() lanza una excepción (tracing no-fatal, criterio 15 de spec 09)', async () => {
  const mockTrace = { ..., generation: jest.fn().mockImplementation(() => { throw new Error('Langfuse caído'); }), ... };
  langfuseService.client = { trace: jest.fn().mockReturnValue(mockTrace) };
  ...
  const result = await service.ask('pregunta', 1);
  expect(result).toEqual({ answer: 'respuesta ok', matched: true });
  expect(mockTrace.generation).toHaveBeenCalled();
});
```
El test fuerza genuinamente la excepción en `trace.generation()` (no en un helper simulado) y confirma tanto que la respuesta llega bien como que `generation` sí fue invocado (no es un falso positivo por camino no ejercitado).

## Criterio 16: `SYSTEM_PROMPT` es byte-idéntico al texto pre-existente.

**Resultado:** PASS

**Comando:**
```bash
python3 -c "
lines = open('rag/specs/04-query-endpoint.md').read().split('\n')
text = '\n'.join(lines[31:34])
import hashlib; print('sha256:', hashlib.sha256(text.encode()).hexdigest())
"
node -e "
const { SYSTEM_PROMPT } = require('./dist/src/modules/query/system-prompt.constant.js');
const crypto = require('crypto');
console.log('sha256:', crypto.createHash('sha256').update(SYSTEM_PROMPT).digest('hex'));
"
```
**Evidencia:**
```
sha256 (spec 04, texto citado antes de esta spec): cde27547ab3bd380798e3a827d42d56220e7482aab117110373c31c9cc30a31b
sha256 (system-prompt.constant.ts, código actual):  cde27547ab3bd380798e3a827d42d56220e7482aab117110373c31c9cc30a31b
```
Hashes idénticos. También coincide con el texto citado en `specs/00-arquitectura-general.md:150-152`.

## Criterio 17: `query.service.spec.ts` — los tests pasan con `getSystemPrompt` mockeado en el `beforeEach`.

**Resultado:** PASS

**Comando:** `npm test -- query.service.spec.ts`
**Evidencia:**
```ts
langfuseService = {
  client: null,
  getSystemPrompt: jest.fn().mockResolvedValue({ text: SYSTEM_PROMPT, promptForTrace: null }),
};
```
```
npm test -- query.service.spec.ts langfuse.service.spec.ts
Test Suites: 2 passed, 2 total
Tests:       17 passed, 17 total
```
El mock exigido por el criterio está presente en el `beforeEach` (confirmado por lectura directa) y los 9 tests del archivo (7 originales + 2 nuevos de esta spec) pasan.

## Criterio 18: Sin `LANGFUSE_PUBLIC_KEY`/`SECRET_KEY`, `/query` sigue respondiendo 200 sin excepción (regresión del criterio 9 de spec 04).

**Resultado:** PASS

**Comando:**
```bash
PORT=3907 ... LANGFUSE_PUBLIC_KEY="" LANGFUSE_SECRET_KEY="" node dist/src/main.js
curl -s -i -X POST http://localhost:3907/query -H "Content-Type: application/json" -d '{"question":"precio de Guatapé"}'
curl -s -i -X POST http://localhost:3907/query -H "Content-Type: application/json" -d '{"question":"¿Cuál es la capital de Francia?"}'
```
**Evidencia:**
```
[Nest] ... WARN [LangfuseService] LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY no configuradas — tracing deshabilitado

HTTP/1.1 200 OK
{"answer":"El precio del tour Guatapé es: ... Precio neto: $100.000 ... Precio al público: $150.000","matched":true}

HTTP/1.1 200 OK
{"answer":"datos no encontrados","matched":false}
```
Ambos casos responden 200, sin excepción ni 500. **Nota de honestidad:** el servidor real que Eder tiene corriendo en Docker (`rag-app`, puerto 3000) sí tiene keys configuradas, por eso este caso se probó en una instancia separada del `dist/` compilado en el host (no se reinició el contenedor), en vez de reutilizar el curl exitoso ya reportado por el orquestador.

## Criterio 19: Los otros 8 criterios de `04-query-endpoint.md` re-corridos íntegros contra el sistema real, sin cambios de contrato.

**Resultado:** PASS (8/8)

**Comandos y evidencia:**

- **Criterio 1 (match con precio)** — contra `rag-app` real (puerto 3000):
```bash
curl -s -i -X POST http://localhost:3000/query -H "Content-Type: application/json" -d '{"question": "¿Cuánto cuesta el tour a Guatapé?"}'
```
```
HTTP/1.1 200 OK
{"answer":"El tour a Guatapé tiene un precio neto de $100.000 y un precio al público de $150.000.","matched":true}
```
Confirmado contra `chunk` real (`docker exec rag-postgres psql ... SELECT content FROM chunks WHERE id='51468a01-...'` → `neto: $100.000. precio_al_publico: $150.000`).

- **Criterio 2 (sin `<think>`)** — visible en todas las respuestas de esta validación (ninguna contiene `<think>`).

- **Criterio 3 (sin relación con catálogo)**:
```bash
curl -s -i -X POST http://localhost:3000/query -H "Content-Type: application/json" -d '{"question": "¿Cuál es la capital de Francia?"}'
```
```
HTTP/1.1 200 OK
{"answer":"datos no encontrados","matched":false}
```

- **Criterio 4 (sin span/generation `chat` en caso sin match)** — vía mock de ingestión (instancia separada en `:3908`, credenciales dummy apuntando a `127.0.0.1:4318`):
```
trace-create - query
span-create - embed-question
span-create - similarity-search
event-create - below_threshold
(sin ningún span-create ni generation-create llamado "chat")
```

- **Criterio 5 (topK por default)** — mismo batch: `similarity-search` con `input: {"topK": 1}` y `output.candidates` con 1 elemento.

- **Criterio 6 (topK=3 trae 3 candidatos)**:
```bash
curl -s -X POST http://localhost:3908/query -H "Content-Type: application/json" -d '{"question": "¿Cuánto cuesta el tour a Guatapé?", "topK": 3}'
```
```
candidates count: 3 -> ids: ['51468a01-...', '57f5963f-...', '88f972b9-...']
```

- **Criterio 7 (question vacío/ausente ⇒ 400)** — contra `rag-app` real:
```
HTTP/1.1 400 Bad Request  {"message":["question no puede estar vacío"],...}
HTTP/1.1 400 Bad Request  {"message":["question no puede estar vacío","question must be a string"],...}
```

- **Criterio 8 (`SIMILARITY_THRESHOLD=0` invierte un match previo)** — instancia separada (`:3909`):
```bash
SIMILARITY_THRESHOLD=0 node dist/src/main.js
curl ... -d '{"question": "¿Cuánto cuesta el tour a Guatapé?"}'
```
```
HTTP/1.1 200 OK
{"answer":"datos no encontrados","matched":false}
```
(la misma pregunta con `SIMILARITY_THRESHOLD=0.4` sí matcheó, ver criterio 1 arriba — distancia real observada `0.307`, correctamente rechazada al bajar el umbral a `0`).

Ningún criterio de spec 04 cambió de comportamiento, status code o shape del body tras esta spec.

---

## Conclusión (validación inicial, histórica)

**5 de 19 criterios fallan**, y los 4 relacionados con el script de seed (6, 7, 8) más el de host (1) comparten dos causas raíz concretas y accionables:

1. **`rag/src/config/env.validation.ts`** define `LANGFUSE_HOST: Joi.string().default('https://cloud.langfuse.com')`. Este default, combinado con el comportamiento interno de `@nestjs/config` (`assignVariablesToProcess`), se escribe en `process.env.LANGFUSE_HOST` **antes** de que `configuration.ts` lo lea, neutralizando por completo la cadena `LANGFUSE_HOST ?? LANGFUSE_BASE_URL ?? default`. El fix de host de esta spec es código muerto en la app real — el bug original que Eder reportó (traces yendo al host global en vez de `us.cloud.langfuse.com`) **sigue sin arreglarse**. Posible solución: quitar el `.default(...)` del schema de Joi para `LANGFUSE_HOST` (dejarlo `optional()` sin default, ya que `configuration.ts` ya provee su propio default), o resolver el host en un solo lugar.
2. **`rag/scripts/seed-langfuse-prompt.ts`** no llama a `dotenv.config()` (a diferencia de `rag/src/database/data-source.ts`, que sí lo hace explícitamente por la misma razón: correr fuera del contexto de Nest). Ejecutar el comando exacto documentado (`npm run seed:langfuse-prompt`) sin haber exportado las variables manualmente al shell falla la autenticación (401) de forma silenciosa — el script imprime un mensaje de éxito falso. Solución: agregar `import * as dotenv from 'dotenv'; dotenv.config();` al inicio del script, igual que `data-source.ts`.

Los 14 criterios restantes (2, 3, 4, 5, 9-18, y el 19 completo) tienen evidencia real y sólida de PASS — en particular, la lógica de negocio del script de seed (crear/idempotencia/no-sobrescribir) y toda la migración de `span` a `generation` con `getSystemPrompt()` están correctamente implementadas y probadas; los fallos son de configuración/carga de entorno, no de la lógica central de la spec.

**No se sugiere promover el `Estado` de la spec a `Implementado`.** Se recomienda devolver a `nestjs-rag-developer` con estos dos fixes puntuales (Joi default de `LANGFUSE_HOST`, y `dotenv.config()` en el script de seed) y re-validar después. El resto del trabajo (helpers `startGeneration`/`endGeneration`, `getSystemPrompt()`, tests) no requiere cambios.

SPEC_STATUS (histórico, superado por la re-validación de arriba): 09-langfuse-observabilidad-y-prompts FAIL (14/19 criterios)

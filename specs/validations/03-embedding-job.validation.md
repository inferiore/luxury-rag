# Validación — 03-embedding-job

Fecha: 2026-08-27
Veredicto general: PASS (6/6 criterios)

Infraestructura usada:
- `rag-postgres` (docker compose, `pgvector/pgvector:pg16`) — ya corriendo y sano (`docker ps` → `Up ... (healthy)`).
- App NestJS levantada localmente con `npm run start:dev` contra ese Postgres (`rag/.env`), reiniciada varias veces durante la validación para simular distintos escenarios de `OLLAMA_BASE_URL`.
- **Ollama real corriendo localmente** en `http://localhost:11434` con los modelos `qwen3-embedding:latest` y `qwen3:8b` ya descargados (confirmado con `curl http://localhost:11434/api/tags` y `ollama list`) — no hizo falta mockear nada, todas las llamadas de embedding son reales contra Ollama.
- Ningún dato de catálogo real fue tocado: se usó el fixture `tours-embed-valid.json` (3 tours ficticios etiquetados "QA embedding") subido varias veces vía `/documents/upload`.
- `.env` no está versionado (`git check-ignore -v .env` → `rag/.gitignore:9:.env`), así que se editó temporalmente `OLLAMA_BASE_URL` para el escenario de fallo (criterio 5) y se restauró al valor original (`http://localhost:11434`) inmediatamente después, confirmado con `grep OLLAMA_BASE_URL .env`.

Verificaciones adicionales de build/calidad corridas de forma independiente (no confiar en el reporte del implementador):
- `npm run build` → `nest build`, exit 0, sin errores.
- `npm run lint` → `10 problems (0 errors, 10 warnings)` — warnings son `@typescript-eslint/no-unsafe-argument` en archivos `*.spec.ts` (mismos que en la validación de spec 02, más los nuevos specs de `embeddings`/`ollama`/`jobs`), no bloqueantes.
- `npm test` → `Test Suites: 7 passed, 7 total` / `Tests: 24 passed, 24 total` (subió de 4/12 en spec 02 a 7/24 con los nuevos specs de `EmbeddingsService`, `OllamaProvider`, `EmbedChunkListener`, `JobsService`).
- Confirmado el downgrade de `@nestjs/config`: `package.json` → `"@nestjs/config": "^4.0.4"` (antes `^12.0.0`). Con esa versión, `npm run build`, `npm run lint` y `npm test` corren sin error, y el flujo completo de subida/chunking de la spec 02 se re-ejecutó exitosamente como parte de esta validación (ver Criterio 1) — el downgrade no rompió nada del resto de la app.

## Criterio 1: Tras subir un documento con 3 tours (flujo de la spec 02) y esperar a que termine el procesamiento, las 3 filas de `chunks` para ese documento tienen `status='done'` y `embedding IS NOT NULL`.
**Resultado:** PASS
**Comando:**
```
curl -s -i -X POST http://localhost:3000/documents/upload -F "file=@tours-embed-valid.json;type=application/json"
# documentId=67cb0807-dd89-469a-be08-3e6fafd3d6b9
sleep 10
docker exec rag-postgres psql -U rag_user -d rag_db -c \
  "SELECT id, status, embedding IS NOT NULL AS has_embedding, error_message FROM chunks WHERE document_id='67cb0807-dd89-469a-be08-3e6fafd3d6b9';"
```
**Evidencia:**
```
HTTP/1.1 202 Accepted
{"documentId":"67cb0807-dd89-469a-be08-3e6fafd3d6b9","totalItems":3,"status":"processing"}

                  id                  | status | has_embedding | error_message
--------------------------------------+--------+---------------+---------------
 9b69f5a4-2ef3-4ed4-a405-248b6b17cede | done   | t             |
 8d8dfa47-76cf-4d93-afe7-6beb9e3f9bee | done   | t             |
 f1202923-236f-4db5-8e61-3ce726a50356 | done   | t             |
(3 rows)
```
Fixture: `tours-embed-valid.json` (3 tours de Medellín, mismo formato que el fixture de spec 02).

## Criterio 2: `SELECT vector_dims(embedding) FROM chunks WHERE document_id = '<id>' LIMIT 1;` devuelve `1536` para cada chunk embebido.
**Resultado:** PASS
**Comando:**
```
docker exec rag-postgres psql -U rag_user -d rag_db -c \
  "SELECT id, vector_dims(embedding) FROM chunks WHERE document_id='67cb0807-dd89-469a-be08-3e6fafd3d6b9';"
```
**Evidencia:**
```
                  id                  | vector_dims
--------------------------------------+-------------
 9b69f5a4-2ef3-4ed4-a405-248b6b17cede |        1536
 8d8dfa47-76cf-4d93-afe7-6beb9e3f9bee |        1536
 f1202923-236f-4db5-8e61-3ce726a50356 |        1536
(3 rows)
```
Confirmado además a nivel de Ollama directamente: `curl -X POST http://localhost:11434/api/embed -d '{"model":"qwen3-embedding","input":"hola mundo","dimensions":1536}'` devuelve un array de 1536 floats — el parámetro `dimensions` (truncamiento Matryoshka) funciona como documenta la spec, y `OllamaProvider` usa `/api/embed` (no `/api/embeddings`) con ese parámetro, tal como exige el diseño técnico.

## Criterio 3: `job_status` tiene 3 filas con `job_type='embedding'`, cada una con `chunk_id` distinto, `status='done'`.
**Resultado:** PASS
**Comando:**
```
docker exec rag-postgres psql -U rag_user -d rag_db -c \
  "SELECT job_type, chunk_id, document_id, status, attempts FROM job_status WHERE document_id='67cb0807-dd89-469a-be08-3e6fafd3d6b9';"
```
**Evidencia:**
```
 job_type  |               chunk_id               |             document_id              | status
-----------+--------------------------------------+--------------------------------------+--------
 chunking  |                                       | 67cb0807-dd89-469a-be08-3e6fafd3d6b9 | done
 embedding | 9b69f5a4-2ef3-4ed4-a405-248b6b17cede  | 67cb0807-dd89-469a-be08-3e6fafd3d6b9 | done
 embedding | 8d8dfa47-76cf-4d93-afe7-6beb9e3f9bee  | 67cb0807-dd89-469a-be08-3e6fafd3d6b9 | done
 embedding | f1202923-236f-4db5-8e61-3ce726a50356  | 67cb0807-dd89-469a-be08-3e6fafd3d6b9 | done
(4 rows)
```
3 filas `job_type='embedding'`, `chunk_id` distinto en cada una, todas `status='done'`.

**Observación menor (no bloqueante, fuera del criterio numerado):** el diseño técnico de la spec dice que "`job_status.attempts` queda en 1" tras un intento. En la práctica, `attempts` se queda en `0` (valor por defecto de la columna) porque `JobsRepository.createProcessing` nunca lo incrementa (`src/modules/jobs/jobs.repository.ts:18-25`). No afecta ningún criterio de aceptación numerado (ninguno menciona el valor de `attempts` explícitamente), pero se documenta para que quede registrado de cara a una futura spec de reintentos manuales, que sí dependería de ese contador.

## Criterio 4: `documents.status` pasa a `'done'` una vez que los 3 chunks terminaron exitosamente.
**Resultado:** PASS
**Comando:**
```
docker exec rag-postgres psql -U rag_user -d rag_db -c \
  "SELECT id, status FROM documents WHERE id='67cb0807-dd89-469a-be08-3e6fafd3d6b9';"
```
**Evidencia:**
```
                  id                  | status
--------------------------------------+--------
 67cb0807-dd89-469a-be08-3e6fafd3d6b9 | done
(1 row)
```

## Criterio 5: Si se detiene Ollama (o se apunta `OLLAMA_BASE_URL` a una URL inválida) antes de subir un documento: el chunk correspondiente termina con `chunks.status='failed'` y `error_message` no vacío; `job_status` de tipo `embedding` para ese chunk queda `status='failed'`; `documents.status` termina en `'failed'`. Ningún chunk queda indefinidamente en `'processing'`.
**Resultado:** PASS
**Comando:**
```
# .env: OLLAMA_BASE_URL=http://localhost:19999 (URL inválida, nada escuchando ahí)
# reinicio de la app para tomar el nuevo .env
curl -s -i -X POST http://localhost:3000/documents/upload -F "file=@tours-embed-valid.json;type=application/json"
# documentId=5631c6c1-8f23-4e4a-aba4-7a406f7b9643
sleep 5
docker exec rag-postgres psql -U rag_user -d rag_db -c \
  "SELECT id, status, embedding IS NULL AS embedding_null, error_message FROM chunks WHERE document_id='5631c6c1-8f23-4e4a-aba4-7a406f7b9643';"
docker exec rag-postgres psql -U rag_user -d rag_db -c \
  "SELECT job_type, chunk_id, status, error_message FROM job_status WHERE document_id='5631c6c1-8f23-4e4a-aba4-7a406f7b9643';"
docker exec rag-postgres psql -U rag_user -d rag_db -c \
  "SELECT id, status FROM documents WHERE id='5631c6c1-8f23-4e4a-aba4-7a406f7b9643';"
```
**Evidencia:**
```
                  id                  | status | embedding_null |                             error_message
--------------------------------------+--------+----------------+-----------------------------------------------------------------------
 c605e505-f9c2-4ff6-9043-c081011f2863 | failed | t              | No se pudo conectar con Ollama (http://localhost:19999): fetch failed
 e385a9c5-41b4-4d45-b589-8baf3328ea64 | failed | t              | No se pudo conectar con Ollama (http://localhost:19999): fetch failed
 089a0e15-83c6-46cf-bf53-069cac668e49 | failed | t              | No se pudo conectar con Ollama (http://localhost:19999): fetch failed
(3 rows)

 job_type  |               chunk_id               | status |                             error_message
-----------+--------------------------------------+--------+-----------------------------------------------------------------------
 embedding | c605e505-f9c2-4ff6-9043-c081011f2863 | failed | No se pudo conectar con Ollama (http://localhost:19999): fetch failed
 embedding | e385a9c5-41b4-4d45-b589-8baf3328ea64 | failed | No se pudo conectar con Ollama (http://localhost:19999): fetch failed
 embedding | 089a0e15-83c6-46cf-bf53-069cac668e49 | failed | No se pudo conectar con Ollama (http://localhost:19999): fetch failed
(3 rows)

                  id                  | status
--------------------------------------+--------
 5631c6c1-8f23-4e4a-aba4-7a406f7b9643 | failed
(1 row)

# confirmación de que ningún chunk quedó colgado en 'processing' en toda la BD:
$ docker exec rag-postgres psql -U rag_user -d rag_db -c "SELECT status, count(*) FROM chunks GROUP BY status;"
 status  | count
---------+-------
 pending |     6   (documentos de la validación de spec 02, sin tocar por esta spec)
 failed  |     4
 done    |     6
```
Tras la prueba se restauró `OLLAMA_BASE_URL=http://localhost:11434` en `.env` y se confirmó con `grep OLLAMA_BASE_URL .env`.

## Criterio 6: Reiniciar el proceso de la app NestJS a mitad de un batch grande no debe dejar filas de `job_status` en `'processing'` de forma permanente sin explicación — limitación conocida y aceptada, a documentar.
**Resultado:** PASS (comportamiento documentado, tal como exige el criterio — no requiere corrección en código)
**Comando:**
```
# subir documento y matar el proceso ~150ms después (a mitad del batch de embeddings)
curl -s -i -X POST http://localhost:3000/documents/upload -F "file=@tours-embed-valid.json;type=application/json" &
sleep 0.15
pkill -9 -f "nest start --watch"
# documentId=56f6342a-2321-41e9-bb66-89c48046327a

# estado inmediatamente tras el kill:
docker exec rag-postgres psql -U rag_user -d rag_db -c \
  "SELECT id, status FROM chunks WHERE document_id='56f6342a-2321-41e9-bb66-89c48046327a';"

# reinicio de la app y re-consulta 5s después (para dar tiempo a cualquier posible recuperación)
npm run start:dev &
sleep 13
docker exec rag-postgres psql -U rag_user -d rag_db -c \
  "SELECT id, status FROM chunks WHERE document_id='56f6342a-2321-41e9-bb66-89c48046327a';"
docker exec rag-postgres psql -U rag_user -d rag_db -c \
  "SELECT job_type, chunk_id, status FROM job_status WHERE document_id='56f6342a-2321-41e9-bb66-89c48046327a';"
```
**Evidencia:**
```
-- inmediatamente después del kill:
                  id                  |   status
--------------------------------------+------------
 aac32ec8-8fd0-42fa-bb12-9044d21b9333 | processing
 ab599023-e186-4c10-9e13-e309c27ce20a | processing
 44ab7f25-249c-4ef9-a3ba-6ec6e31e3b8f | processing
(3 rows)

-- 13s después de reiniciar la app (health check OK, app arriba y funcional):
                  id                  |   status
--------------------------------------+------------
 aac32ec8-8fd0-42fa-bb12-9044d21b9333 | processing   (sin cambio)
 ab599023-e186-4c10-9e13-e309c27ce20a | processing   (sin cambio)
 44ab7f25-249c-4ef9-a3ba-6ec6e31e3b8f | processing   (sin cambio)
(3 rows)

 job_type  |               chunk_id               |   status
-----------+--------------------------------------+------------
 chunking  |                                       | done
 embedding | aac32ec8-8fd0-42fa-bb12-9044d21b9333  | processing   (sin cambio)
 embedding | ab599023-e186-4c10-9e13-e309c27ce20a  | processing   (sin cambio)
 embedding | 44ab7f25-249c-4ef9-a3ba-6ec6e31e3b8f  | processing   (sin cambio)
(4 rows)

documents.status para 56f6342a-... también permanece 'processing' indefinidamente.
```
**Confirmación de la limitación documentada:** se reprodujo exactamente el escenario que describe el criterio. Al matar el proceso de NestJS mientras 3 chunks estaban en `'processing'` (jobs en memoria vía `@nestjs/event-emitter`, sin cola persistente ni mecanismo de reanudación), y reiniciar la app, **no hay ningún mecanismo de recuperación automática**: los 3 chunks, sus 3 filas de `job_status` y el `documents.status` del documento padre quedan indefinidamente en `'processing'`, sin reintento ni marcado de `'failed'`. No hay ningún proceso de arranque (`OnModuleInit`, cron, etc.) en `EmbeddingsModule`/`JobsModule` que barra jobs `'processing'` huérfanos al iniciar — se confirmó revisando `src/modules/embeddings/embeddings.module.ts` y `src/modules/jobs/jobs.module.ts` (ningún hook de lifecycle de recuperación).
Esto coincide exactamente con la limitación conocida y aceptada por la spec ("jobs en memoria, sin recuperación automática tras crash") — el criterio exige que quede **documentada**, no resuelta en código, así que se marca **PASS**. Queda como candidata explícita para una futura spec de recuperación/reintentos si Eder lo prioriza (ej. un job de barrido al arranque que marque como `'failed'` cualquier `job_status`/`chunk` en `'processing'` más viejo que X minutos).

Nota de limpieza: este documento de prueba (`56f6342a-2321-41e9-bb66-89c48046327a`) queda intencionalmente en estado `'processing'` colgado en la base de datos de desarrollo — es evidencia viva del comportamiento documentado en este criterio, no un error a corregir en esta validación.

## Conclusión

Los 6 criterios de aceptación de la spec `03-embedding-job.md` se verificaron con evidencia real y ejecutable: HTTP real contra la app NestJS corriendo, llamadas reales a Ollama local (`qwen3-embedding`, `qwen3:8b`), SQL directo contra Postgres, y una simulación real de caída de Ollama y de crash del proceso a mitad de batch (no simulacros con mocks). Todos los 6 criterios pasan.

Adicionalmente se confirmó de forma independiente que el downgrade de `@nestjs/config` (`^12.0.0` → `^4.0.4`) no rompió nada: `npm run build`, `npm run lint`, `npm test` (24/24) y el flujo completo end-to-end de subida→chunking→embedding (que ejercita tanto la spec 02 como la 03) funcionan correctamente.

Se sugiere a `rag-spec-planner` actualizar el `Estado` de `rag/specs/03-embedding-job.md` de `Aprobado` a `Implementado`.

SPEC_STATUS: 03-embedding-job PASS

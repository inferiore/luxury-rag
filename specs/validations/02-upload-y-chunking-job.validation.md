# Validación — 02-upload-y-chunking-job

Fecha: 2026-08-27
Veredicto general: PASS (9/9 criterios)

Infraestructura usada: `rag-postgres` (docker compose, `pgvector/pgvector:pg16`) ya corriendo y sano; app NestJS levantada localmente con `npm run start:dev` contra ese Postgres (`rag/.env`). No se usó ningún mock — todas las llamadas son HTTP reales contra el servidor Express/Nest en `localhost:3000` y consultas SQL directas con `docker exec rag-postgres psql`.

Adicionalmente, antes de validar criterios funcionales se corrieron de forma independiente:
- `npm run build` → compiló sin errores (`nest build`, exit 0).
- `npm run lint` → `6 problems (0 errors, 6 warnings)` — 0 errores, warnings son `@typescript-eslint/no-unsafe-argument` en specs de test (no bloqueantes).
- `npm test` → `Test Suites: 4 passed, 4 total / Tests: 12 passed, 12 total`.

## Criterio 1: `npm run migration:run` aplica la migración sin error; `\dt` lista `documents`, `chunks`, `job_status`; `\d chunks` muestra `embedding` como `vector(1536)`; `\di chunks_embedding_hnsw_idx` confirma el índice HNSW.
**Resultado:** PASS
**Comando:**
```
docker exec rag-postgres psql -U rag_user -d rag_db -c "\dt"
docker exec rag-postgres psql -U rag_user -d rag_db -c "\d chunks"
docker exec rag-postgres psql -U rag_user -d rag_db -c "\di chunks_embedding_hnsw_idx"
npm run migration:run   # re-ejecutado para confirmar "sin error" / idempotencia
```
**Evidencia:**
```
$ \dt
 public | chunks     | table | rag_user
 public | documents  | table | rag_user
 public | job_status | table | rag_user
 public | migrations | table | rag_user

$ \d chunks (columna relevante)
 embedding      | vector(1536)             |           |          |
Indexes:
    "chunks_pkey" PRIMARY KEY, btree (id)
    "chunks_document_id_idx" btree (document_id)
    "chunks_embedding_hnsw_idx" hnsw (embedding vector_cosine_ops)
    "chunks_status_idx" btree (status)

$ \di chunks_embedding_hnsw_idx
 public | chunks_embedding_hnsw_idx | index | rag_user | chunks

$ npm run migration:run
...
query: SELECT * FROM "migrations" "migrations" ORDER BY "id" DESC
No migrations are pending
```
Nota: no se hizo `migration:revert` (acción destructiva bloqueada por el classifier del sandbox); en su lugar se confirmó que el esquema ya aplicado coincide exactamente con lo especificado y que re-correr `migration:run` no falla y reporta "No migrations are pending" (comportamiento correcto de idempotencia).

## Criterio 2: `POST /documents/upload` con un archivo JSON válido de 3 tours devuelve HTTP 202 con `documentId` (UUID) y `totalItems=3`.
**Resultado:** PASS
**Comando:**
```
curl -s -i -X POST http://localhost:3000/documents/upload \
  -F "file=@tours-valid.json;type=application/json"
```
**Evidencia:**
```
HTTP/1.1 202 Accepted
Content-Type: application/json; charset=utf-8

{"documentId":"ed5d474c-8a77-4cdc-98ac-24315eae9f2c","totalItems":3,"status":"processing"}
```
Fixture usado: `tours-valid.json` con 3 tours (Guatapé+Peñol, Comuna 13, Tour del Café), campos completos según el ejemplo de la spec.

## Criterio 3: Segundos después, `chunks` tiene exactamente 3 filas con `document_id` = documentId devuelto, `status='pending'`, `embedding IS NULL`, `content` no vacío.
**Resultado:** PASS
**Comando:**
```
docker exec rag-postgres psql -U rag_user -d rag_db -c \
  "SELECT id, document_id, status, embedding IS NULL AS embedding_is_null, length(content) AS content_len FROM chunks WHERE document_id='ed5d474c-8a77-4cdc-98ac-24315eae9f2c';"
```
**Evidencia:**
```
                  id                  |             document_id              | status  | embedding_is_null | content_len
--------------------------------------+--------------------------------------+---------+-------------------+-------------
 47f7e8a5-6974-4f3a-afb4-9a0a91c23d85 | ed5d474c-8a77-4cdc-98ac-24315eae9f2c | pending | t                 |         187
 f0a0abf4-2f1c-4b49-98fe-76ed23e7725c | ed5d474c-8a77-4cdc-98ac-24315eae9f2c | pending | t                 |         171
 56726fe1-48b8-4561-970b-8099158802ec | ed5d474c-8a77-4cdc-98ac-24315eae9f2c | pending | t                 |         172
(3 rows)
```
Exactamente 3 filas, todas `pending`, `embedding IS NULL`, `content` con longitud > 0.

## Criterio 4: `job_status` tiene exactamente 1 fila con `job_type='chunking'`, `document_id` correcto, `chunk_id IS NULL`, `status='done'`.
**Resultado:** PASS
**Comando:**
```
docker exec rag-postgres psql -U rag_user -d rag_db -c \
  "SELECT job_type, document_id, chunk_id, status FROM job_status WHERE document_id='ed5d474c-8a77-4cdc-98ac-24315eae9f2c';"
```
**Evidencia:**
```
 job_type |             document_id              | chunk_id | status
----------+--------------------------------------+----------+--------
 chunking | ed5d474c-8a77-4cdc-98ac-24315eae9f2c |          | done
(1 row)
```

## Criterio 5: El campo `content` de una fila de `chunks` contiene, en texto legible, nombre, descripción y precio del tour correspondiente.
**Resultado:** PASS
**Comando:**
```
docker exec rag-postgres psql -U rag_user -d rag_db -c \
  "SELECT content FROM chunks WHERE document_id='ed5d474c-8a77-4cdc-98ac-24315eae9f2c' LIMIT 1;"
```
**Evidencia:**
```
Tour: Tour Guatapé + Peñol. Descripción: Recorrido por el pueblo de Guatapé y subida al Peñol. Precio: 180000 COP / 45 USD. Lugar de embarque: Hotel en Medellín. Lugar: Guatapé, Medellín.
```
Contiene nombre, descripción, precio COP/USD, lugar de embarque y lugar/ciudad, todo legible.

## Criterio 6: `POST /documents/upload` con un archivo que no es JSON válido devuelve HTTP 400 y no crea ninguna fila en `documents` ni `chunks`.
**Resultado:** PASS
**Comando:**
```
echo "{esto no es json valido" > tours-invalid.json
curl -s -i -X POST http://localhost:3000/documents/upload -F "file=@tours-invalid.json;type=application/json"
```
**Evidencia:**
```
HTTP/1.1 400 Bad Request
{"message":"El archivo no contiene JSON válido","error":"Bad Request","statusCode":400}
```
Conteo de `documents` antes y después de la llamada: `2` → `2` (sin cambio). Como `chunks.document_id` tiene FK NOT NULL a `documents`, la ausencia de nueva fila en `documents` garantiza que tampoco se creó ninguna en `chunks`.

## Criterio 7: `POST /documents/upload` con un array donde un item no tiene `nombre` devuelve HTTP 400 identificando el índice/campo, y no crea ninguna fila (ni para los items válidos del mismo array).
**Resultado:** PASS
**Comando:**
```
curl -s -i -X POST http://localhost:3000/documents/upload -F "file=@tours-missing-nombre.json;type=application/json"
```
Fixture: array de 2 items — índice 0 válido (con `nombre`), índice 1 sin `nombre`.
**Evidencia:**
```
HTTP/1.1 400 Bad Request
{"statusCode":400,"message":"El item en la posición 1 no cumple la validación del campo 'nombre'","errors":[{"index":1,"field":"nombre","constraint":"nombre should not be empty, nombre must be a string"}]}
```
Conteo `documents` antes/después: `2`→`2`. Conteo `chunks` antes/después: `6`→`6`. Confirmado: no se creó fila ni para el item 0 (válido) del mismo batch — rechazo atómico de todo el batch, como exige la spec.

## Criterio 8: `POST /documents/upload` sin el campo `file` devuelve HTTP 400.
**Resultado:** PASS
**Comando:**
```
curl -s -i -X POST http://localhost:3000/documents/upload -F "otroField=algo"
curl -s -i -X POST http://localhost:3000/documents/upload   # sin ningún campo
```
**Evidencia:**
```
HTTP/1.1 400 Bad Request
{"message":"El campo 'file' es requerido","error":"Bad Request","statusCode":400}
```
(mismo resultado en ambos casos)

## Criterio 9: `documents.status` de un documento recién subido es `'processing'` inmediatamente después de la respuesta 202 (no cambia a `'done'` en esta spec).
**Resultado:** PASS
**Comando:**
```
docker exec rag-postgres psql -U rag_user -d rag_db -c \
  "SELECT id, status, total_items FROM documents WHERE id='ed5d474c-8a77-4cdc-98ac-24315eae9f2c';"
```
**Evidencia:**
```
                  id                  |   status   | total_items
--------------------------------------+------------+-------------
 ed5d474c-8a77-4cdc-98ac-24315eae9f2c | processing |           3
(1 row)
```
Consultado ~2 segundos después del 202 (tras confirmar que el job de chunking ya había terminado, criterio 4) — el `documents.status` permanece `'processing'`, tal como exige la spec (no cambia a `'done'` hasta la spec 03 de embeddings).

## Verificaciones adicionales de build/calidad (no son criterios de aceptación explícitos, pero se re-derivaron para no confiar en el reporte del implementador)

- `npm run build` → `nest build`, sin errores.
- `npm run lint` → `0 errors, 6 warnings` (warnings de tipo `any` en archivos `*.spec.ts`, no bloqueantes).
- `npm test` → `Test Suites: 4 passed, 4 total`, `Tests: 12 passed, 12 total`.
- Logs de la app (`nest start --watch`) durante todas las pruebas de este documento: sin stack traces ni errores no manejados; el único `ERROR` visto en consola aparece en `npm test` y es esperado (test unitario que simula un fallo de DB para verificar el manejo de errores del listener, no un fallo real de infraestructura).

## Conclusión

Los 9 criterios de aceptación de la spec `02-upload-y-chunking-job.md` se verificaron con evidencia real y ejecutable (HTTP real contra la app corriendo, SQL directo contra Postgres, build/lint/test corridos de forma independiente). Todos pasan.

Se sugiere a `rag-spec-planner` actualizar el `Estado` de `rag/specs/02-upload-y-chunking-job.md` de `Aprobado` a `Implementado`.

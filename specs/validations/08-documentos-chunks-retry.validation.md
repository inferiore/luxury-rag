# Validación — 08-documentos-chunks-retry

Fecha: 2026-08-27
Veredicto general: PASS (31/31 criterios)

## Metodología

Se levantó el ambiente aislado `rag/docker-compose.test.yml` (`rag-app-test` en `:3001`, `rag-postgres-test` en `:5433`, volumen `rag_pgdata_test` vacío al inicio). Las migraciones corrieron desde cero al arrancar. El ambiente de dev (`rag-app`/`rag-postgres` en `:3000`/`:5432`) permaneció corriendo y saludable durante toda la validación, sin ser tocado.

Para provocar fallos reales de embedding se sobreescribió temporalmente `OLLAMA_BASE_URL` del servicio `app-test` en `docker-compose.test.yml` a `http://invalid-ollama-host-for-qa:11434` y se recreó solo ese contenedor (`docker compose -f docker-compose.test.yml up -d app-test`), sin afectar el volumen de datos ni el contenedor de Postgres. Al terminar cada tanda de pruebas de fallo se restauró el valor original (`http://host.docker.internal:11434`) de la misma forma. El archivo quedó restaurado byte a byte al finalizar (`git diff` sin cambios).

Para el caso límite del criterio 22 (documento `failed` con 0 chunks) se insertó directamente por SQL (`docker exec rag-postgres-test psql ...`) un documento con `status='failed'` y sin filas en `chunks`, usando `gen_random_uuid()` para generar un UUID válido (un primer intento con un UUID inventado a mano no conforme a RFC4122 produjo un 404 espurio por fallar la validación `isUUID()` del propio backend — no un bug, error de fixture propio, documentado abajo en el criterio 22).

Para los criterios de frontend (24-31) se corrió una segunda instancia de Vite en el puerto `5174` (`VITE_API_BASE_URL=http://localhost:3001`), sin tocar el frontend de dev que Eder tenía corriendo en `5173`. Se ajustó temporalmente `CORS_ORIGINS` de `app-test` a `http://localhost:5174` (mismo patrón de edición temporal + reversión que con `OLLAMA_BASE_URL`). Se automatizó con Playwright 1.62.1 + Chromium (instalado ad-hoc en el scratchpad, usando el caché de navegadores ya presente en `~/Library/Caches/ms-playwright`), capturando red (`page.on('request')`) y DOM real, no solo capturas de pantalla.

Al finalizar: `docker compose -f docker-compose.test.yml down -v` (contenedores y volumen de test eliminados), proceso Vite de prueba (`5174`) detenido, `docker-compose.test.yml` restaurado a su contenido original. El ambiente de dev (`3000`/`5432`, frontend `5173`) permaneció intacto y funcional todo el tiempo.

Documentos de fixture usados (todos vía `POST /documents/upload` real, JSON válido genérico): `doc1.json`, `doc2.json`, `doc3.json` (3 items), `doc-fail1.json` (1 item), `doc-fail2.json`/`doc-fail3.json` (2 items c/u), `doc-ui-fail.json` (1 item, subido desde la UI), más un documento `doc-fantasma.json` insertado directamente por SQL para el caso límite.

---

## Listado de documentos

### Criterio 1: `GET /documents` con ≥2 documentos → 200, `items[]`, `page=1`, `limit=20`, `total>=2`, `totalPages>=1`, orden `createdAt` DESC
**Resultado:** PASS
**Comando:** `curl -s -i http://localhost:3001/documents`
**Evidencia:**
```
HTTP/1.1 200 OK
{"items":[{"id":"ec1384bd-...","originalFilename":"doc2.json",...,"createdAt":"2026-08-28T02:52:41.095Z"},
          {"id":"e1baead8-...","originalFilename":"doc1.json",...,"createdAt":"2026-08-28T02:52:35.069Z"}],
 "page":1,"limit":20,"total":2,"totalPages":1}
```
doc2 (más reciente) aparece antes que doc1 — orden descendente confirmado.

### Criterio 2: `?page=1&limit=1` con ≥2 documentos → `items.length===1`, `totalPages>=2`
**Resultado:** PASS
**Comando:** `curl -s "http://localhost:3001/documents?page=1&limit=1"`
**Evidencia:**
```
{"items":[{...}],"page":1,"limit":1,"total":2,"totalPages":2}
```

### Criterio 3: `?limit=500` → no 400, máximo 100 items
**Resultado:** PASS
**Comando:** `curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3001/documents?limit=500"`
**Evidencia:**
```
200
limit field: 100 items len: 2
```

### Criterio 4: `?page=0` o `?page=-1` → 400
**Resultado:** PASS
**Comando:** `curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3001/documents?page=0"` / `?page=-1`
**Evidencia:**
```
page=0 -> 400
page=-1 -> 400
```

## Detalle de documento

### Criterio 5: `GET /documents/<id-existente>` → 200 con shape exacto
**Resultado:** PASS
**Comando:** `curl -s -i http://localhost:3001/documents/e1baead8-e61d-49a0-b26b-72736483536a`
**Evidencia:**
```
HTTP/1.1 200 OK
{"id":"e1baead8-e61d-49a0-b26b-72736483536a","originalFilename":"doc1.json","totalItems":1,"status":"done","createdAt":"2026-08-28T02:52:35.069Z","updatedAt":"2026-08-28T02:52:37.356Z"}
```

### Criterio 6: UUID válido pero inexistente → 404
**Resultado:** PASS
**Comando:** `curl -s -i http://localhost:3001/documents/00000000-0000-0000-0000-000000000000`
**Evidencia:**
```
404
{"message":"Documento 00000000-0000-0000-0000-000000000000 no encontrado","error":"Not Found","statusCode":404}
```

## Listado de chunks de un documento

### Criterio 7: documento con 3 chunks → `items.length===3`, orden ASC, shape exacto sin `rawData`/`embedding`
**Resultado:** PASS
**Comando:** `curl -s http://localhost:3001/documents/f8d6ea54-11d6-4cff-aa43-dcc7197f92d7/chunks`
**Evidencia:**
```
3 items, createdAt 02:53:10.736 < 02:53:10.755 < 02:53:10.763 (ascendente)
keys por item: ['content','createdAt','documentId','errorMessage','id','status','updatedAt']
```

### Criterio 8: documento inexistente → 404
**Resultado:** PASS
**Comando:** `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/documents/00000000-0000-0000-0000-000000000000/chunks`
**Evidencia:** `404`

### Criterio 9: paginación de chunks igual que documentos
**Resultado:** PASS
**Comando:** `curl -s "http://localhost:3001/documents/<id>/chunks?page=1&limit=1"`, `?limit=500`, `?page=0`
**Evidencia:**
```
limit=1: 1 item, totalPages=3
limit=500 -> 200
page=0 -> 400
```

## Retry de chunk individual

### Criterio 10: fallo real de embedding (OLLAMA_BASE_URL inválida) → chunk `failed` con `errorMessage`, documento `failed`
**Resultado:** PASS
**Comando:** editar `OLLAMA_BASE_URL` a host inválido, recrear `app-test`, `curl -X POST .../documents/upload -F file=@doc-fail1.json`
**Evidencia:**
```
Documento: {"status":"failed", ...}
Chunk: {"status":"failed","errorMessage":"No se pudo conectar con Ollama (http://invalid-ollama-host-for-qa:11434): fetch failed", ...}
```

### Criterio 11: retry individual con Ollama restaurado → 202 con shape exacto
**Resultado:** PASS
**Comando:** `curl -i -X POST http://localhost:3001/documents/b598b10d-.../chunks/20268a65-.../retry`
**Evidencia:**
```
HTTP/1.1 202 Accepted
{"chunkId":"20268a65-...","documentId":"b598b10d-...","status":"pending"}
```

### Criterio 12: inmediatamente tras el 202, chunk en `pending`/`processing` con `error_message IS NULL`
**Resultado:** PASS
**Comando:** `docker exec rag-postgres-test psql -U rag_test_user -d rag_test_db -c "SELECT status, error_message FROM chunks WHERE id='20268a65-...';"`
**Evidencia:**
```
   status   | error_message 
------------+---------------
 processing | 
```

### Criterio 13: tras esperar, chunk `done` con embedding, documento `done`
**Resultado:** PASS
**Comando:** `docker exec rag-postgres-test psql ... -c "SELECT id, status, (embedding IS NOT NULL) FROM chunks WHERE id='20268a65-...';"`
**Evidencia:**
```
id | status | has_embedding
20268a65-... | done | t
documento b598b10d-... -> status: done
```

### Criterio 14: `job_status` tiene fila nueva `done`, la fallida original persiste sin sobreescribirse
**Resultado:** PASS
**Comando:** `docker exec rag-postgres-test psql ... -c "SELECT id, job_type, status, error_message, created_at FROM job_status WHERE chunk_id='20268a65-...' ORDER BY created_at;"`
**Evidencia:**
```
1c6d15b6-... | embedding | failed | No se pudo conectar con Ollama... | 02:54:09.09188
8f69f524-... | embedding | done   |                                   | 02:54:53.309679
```
(2 filas — la original `failed` no fue tocada, y hay una fila nueva `done`.)

### Criterio 15: retry sobre chunk `done` → 409 con mensaje que incluye el estado actual
**Resultado:** PASS
**Comando:** `curl -i -X POST http://localhost:3001/documents/b598b10d-.../chunks/20268a65-.../retry`
**Evidencia:**
```
HTTP/1.1 409 Conflict
{"message":"El chunk 20268a65-2255... está en estado 'done', solo se puede reintentar si está en 'failed'", "statusCode":409}
```
**Nota (punto de atención #1):** el 404 unificado de los 3 casos (documento inexistente, chunk inexistente, chunk de otro documento) no aplica aquí — este es el caso 409, no 404 — y se comporta según lo exigido: incluye el estado actual del chunk (`'done'`) tal como pide el criterio.

### Criterio 16: chunk existente pero de otro documento → 404
**Resultado:** PASS
**Comando:** `curl -i -X POST http://localhost:3001/documents/b598b10d-.../chunks/d8cb6643-.../retry` (d8cb6643 pertenece al documento 4c03fea6, no a b598b10d)
**Evidencia:**
```
HTTP/1.1 404 Not Found
{"message":"Chunk d8cb6643-... no encontrado para el documento b598b10d-...","statusCode":404}
```
Confirmado con el código fuente (`documents.service.ts`, método `retryChunk`): el mismo `notFoundMessage` se usa para los 3 casos (documento no existe, chunk no existe, `chunk.documentId !== documentId`). La spec solo exige HTTP 404 con mensaje, sin exigir textos distintos por caso — el criterio pasa tal como está redactado.

### Criterio 17: documento inexistente en URL de retry individual → 404
**Resultado:** PASS
**Comando:** `curl -i -X POST http://localhost:3001/documents/00000000-0000-0000-0000-000000000000/chunks/20268a65-.../retry`
**Evidencia:**
```
HTTP/1.1 404 Not Found
{"message":"Chunk 20268a65-... no encontrado para el documento 00000000-0000-0000-0000-000000000000","statusCode":404}
```

## Retry masivo por documento

### Criterio 18: documento con ≥2 chunks `failed`, Ollama restaurado → 202 con `retriedCount:2`, `status:'processing'`
**Resultado:** PASS
**Comando:** `curl -i -X POST http://localhost:3001/documents/25090dd3-.../retry-failed-chunks`
**Evidencia:**
```
HTTP/1.1 202 Accepted
{"documentId":"25090dd3-...","retriedCount":2,"status":"processing"}
```

### Criterio 19: inmediatamente tras el 202, documento `processing`, ambos chunks `pending`/`processing` con `error_message IS NULL`
**Resultado:** PASS
**Comando:** `curl ... /retry-failed-chunks && docker exec rag-postgres-test psql ... -c "SELECT (SELECT status FROM documents WHERE id=...) as doc_status, id, status, error_message FROM chunks WHERE document_id=...;"` (encadenado en un solo comando para minimizar latencia)
**Evidencia:**
```
 doc_status |                  id                  |   status   | error_message 
------------+--------------------------------------+------------+---------------
 processing | 74ac823d-...                          | processing | 
 processing | 81ccedb7-...                          | processing | 
```
(Un primer intento con dos `docker exec` separados llegó tarde y ya mostraba `done` en ambos chunks — el embedding local es muy rápido; se repitió combinando la consulta en una sola invocación inmediatamente después del `curl` para capturar el estado intermedio real.)

### Criterio 20: tras esperar, ambos chunks `done`, documento `done`
**Resultado:** PASS
**Comando:** `docker exec rag-postgres-test psql ... -c "SELECT (SELECT status FROM documents WHERE id=...) as doc_status, id, status FROM chunks WHERE document_id=...;"`
**Evidencia:**
```
 doc_status |                  id                  | status 
------------+--------------------------------------+--------
 done       | 81ccedb7-...                          | done
 done       | 74ac823d-...                          | done
```

### Criterio 21: documento sin chunks `failed` (`status='done'`) → 409
**Resultado:** PASS
**Comando:** `curl -i -X POST http://localhost:3001/documents/e1baead8-.../retry-failed-chunks`
**Evidencia:**
```
HTTP/1.1 409 Conflict
{"message":"El documento e1baead8-... no tiene chunks en estado 'failed' para reintentar","statusCode":409}
```

### Criterio 22: documento `failed` con 0 chunks (caso límite, insertado por SQL) → 409, mismo comportamiento que criterio 21
**Resultado:** PASS
**Comando:**
```
docker exec rag-postgres-test psql -U rag_test_user -d rag_test_db -c \
  "INSERT INTO documents (id, original_filename, total_items, status) VALUES (gen_random_uuid(), 'doc-fantasma.json', 0, 'failed') RETURNING id;"
curl -i -X POST http://localhost:3001/documents/a3b2387f-5795-40b7-b32b-5dfa712b7a05/retry-failed-chunks
```
**Evidencia:**
```
HTTP/1.1 409 Conflict
{"message":"El documento a3b2387f-... no tiene chunks en estado 'failed' para reintentar","statusCode":409}
```
Nota de fixture: un primer intento insertando manualmente el id `11111111-2222-3333-4444-555555555555` produjo un 404 en `GET /documents/<id>` y en el retry — se verificó que fue un artefacto propio (ese string no es un UUID RFC4122 válido: `isUUID('11111111-2222-3333-4444-555555555555') === false` en `class-validator`, confirmado con `node -e` dentro del contenedor) y no un bug del sistema. Se repitió con `gen_random_uuid()` y el comportamiento fue el esperado.

### Criterio 23: documento inexistente en retry masivo → 404
**Resultado:** PASS
**Comando:** `curl -i -X POST http://localhost:3001/documents/00000000-0000-0000-0000-000000000000/retry-failed-chunks`
**Evidencia:**
```
HTTP/1.1 404 Not Found
{"message":"Documento 00000000-0000-0000-0000-000000000000 no encontrado","statusCode":404}
```

## Frontend

Frontend de prueba corrido con `VITE_API_BASE_URL=http://localhost:3001` en el puerto `5174` (ver "Metodología"). Verificación automatizada con Playwright + Chromium, inspeccionando DOM y red reales.

### Criterio 24: sección `DocumentsView` entre Upload y Ask, con columnas correctas
**Resultado:** PASS
**Comando:** script Playwright, `page.$$eval('main.app-main > section h2', ...)` y `.documents-table thead th`
**Evidencia:**
```
HEADINGS_ORDER ["Subir catálogo de tours","Documentos","Preguntar sobre el catálogo"]
CRITERIO24_HEADERS ["Archivo","Total items","Estado","Fecha",""]
```
(Ver captura `screenshot-24`/`screenshot-26` — tabla visible con 7 documentos.)

### Criterio 25: badge de color por estado (`info`=pending/processing, `success`=done, `error`=failed)
**Resultado:** PASS
**Comando:** `page.$$eval('.documents-table tbody tr.document-row', ... .badge.className)`
**Evidencia:**
```
{"text":"failed","cls":"badge badge-error"}
{"text":"done","cls":"badge badge-success"}
(x6)
```
Clase CSS confirmada en `rag/frontend/src/index.css` (`.badge-info`, `.badge-success`, `.badge-error` mapean a `--info-bg`/`--success-bg`/`--error-bg`).

### Criterio 26: clic en fila expande sub-tabla de chunks
**Resultado:** PASS
**Comando:** click en fila `doc3.json`, `page.waitForSelector('.chunks-panel-row .chunks-table')`
**Evidencia:**
```
CRITERIO26_CHUNK_ROWS 3
CRITERIO26_CONTENTS ["nombre: Tour Cafetero A. precio: 70000.", "nombre: Tour Cafetero B. precio: 80000.", "nombre: Tour Cafetero C. precio: 90000."]
```

### Criterio 27: polling `GET /documents` cada ~3s mientras `processing`, se detiene al llegar a `done`/`failed`
**Resultado:** PASS
**Comando:** subida real desde la UI (`doc-ui-fail.json`, con Ollama apuntando a host inválido) + `page.on('request')`
**Evidencia:**
```
TIMESTAMPS [1787886087669, 1787886088307, 1787886091326]
```
(request 1: mount inicial; request 2: invalidación tras `onSuccess` del upload; request 3: ~3019ms después — cadencia de polling confirmada. Documento pasó a `failed` rápidamente y no hubo más requests en los 6s siguientes: `COUNT_BEFORE_EXTRA_WAIT 3, COUNT_AFTER_EXTRA_WAIT 3` — polling detenido.)

### Criterio 28: botón "Reintentar" de chunk visible solo si `chunk.status === 'failed'`
**Resultado:** PASS
**Comando:** inspección DOM de `doc-ui-fail.json` (1 chunk `failed`) y `doc3.json` (3 chunks `done`)
**Evidencia:**
```
CRITERIO28_FAILED_DOC_CHUNKS [{"status":"failed","hasRetryBtn":true}]
CRITERIO28_DONE_DOC_CHUNKS [{"status":"done","hasRetryBtn":false},{"status":"done","hasRetryBtn":false},{"status":"done","hasRetryBtn":false}]
```
Los estados `pending`/`processing` son demasiado efímeros para capturarlos en vivo de forma confiable (el embedding local resuelve en <1s); se complementa con inspección de código (`DocumentsView.tsx` línea 105: `{chunk.status === 'failed' && (<button>...)}`), que confirma que la condición cubre exactamente y únicamente `'failed'`.

### Criterio 29: botón "Reintentar fallidos" visible solo si `document.status === 'failed'`
**Resultado:** PASS
**Comando:** inspección DOM de las 8 filas de la tabla de documentos
**Evidencia:**
```
doc-ui-fail.json  failed -> hasRetryFailedBtn: true
doc-fantasma.json failed -> hasRetryFailedBtn: true
doc-fail3.json    done   -> hasRetryFailedBtn: false
doc-fail2.json    done   -> hasRetryFailedBtn: false
doc-fail1.json    done   -> hasRetryFailedBtn: false
doc3.json         done   -> hasRetryFailedBtn: false
doc2.json         done   -> hasRetryFailedBtn: false
doc1.json         done   -> hasRetryFailedBtn: false
```

### Criterio 30: clic en "Reintentar" dispara invalidación (`GET /documents`, `GET .../chunks`) y refleja nuevo estado sin recargar
**Resultado:** PASS
**Comando:** click en botón "Reintentar" del chunk `failed` de `doc-ui-fail.json` (Ollama restaurado), con `page.on('request')`
**Evidencia:**
```
RETRY_RESPONSE_STATUS 202
CRITERIO30_REQUESTS_AFTER_RETRY [
  "http://localhost:3001/documents?page=1&limit=20",
  "http://localhost:3001/documents/ef4c6ab0-.../chunks?page=1&limit=20"
]
CRITERIO30_UPDATED_CHUNK_STATUS processing
```
(Ver `screenshot-30`: tanto el documento como el chunk muestran badge "Processing" tras el clic, sin recarga de página.)

### Criterio 31: "Reintentar fallidos" sobre documento `failed` con 0 chunks → mensaje exacto "Este documento no tiene chunks para reintentar; debe volver a subirse."
**Resultado:** PASS
**Comando:** click en "Reintentar fallidos" de `doc-fantasma.json` (0 chunks, insertado por SQL para el criterio 22)
**Evidencia:**
```
CRITERIO31_MESSAGE "Este documento no tiene chunks para reintentar; debe volver a subirse."
```
(Ver `screenshot-31`.)

**Verificación del punto de atención #2 (revisión de código, `rag/frontend/src/components/DocumentsView.tsx`):**
- Líneas 9-26: la constante `NO_CHUNKS_TO_RETRY_MESSAGE` y la función `retryFailedErrorMessage()` traducen **cualquier** 409 de la mutación `retryFailedMutation` (`retryFailedChunks`, botón "Reintentar fallidos") a ese texto fijo — confirmado que el backend real solo devuelve un 409 genérico ("no tiene chunks en estado 'failed'") tanto para "ya no quedan failed" como para el caso límite de 0 chunks, y que el frontend no puede distinguirlos, por lo que traduce siempre.
- Esta traducción está **acotada** a `retryFailedErrorMessage()`, usada únicamente en el bloque `{retryFailedMutation.isError && ...}` de `DocumentRow` (líneas 225-233).
- El mutation de retry **individual** de chunk (`ChunkRow`, líneas 87-121) usa `retryMutation.error.message` **verbatim**, sin traducción — confirmado en el criterio 15 de backend (mensaje real "está en estado 'done'..." se propagaría tal cual a la UI). No hay ningún cambio genérico que afecte el patrón de `UploadView`/`AskView` ni el 409 de retry individual.

---

## Resumen

31/31 criterios PASS. No se encontraron discrepancias entre el comportamiento observado y lo exigido por la spec, incluyendo los dos puntos de atención señalados explícitamente por los implementadores (404 unificado en retry individual — criterios 16/17 — y la traducción específica del 409 en "Reintentar fallidos" — criterio 31 — que no contamina el criterio 15).

**Recomendación:** dado que los 31 criterios pasan con evidencia reproducible e independiente, se sugiere a Eder que `rag-spec-planner` actualice el `Estado` de `rag/specs/08-documentos-chunks-retry.md` de `Aprobado` a `Implementado`.

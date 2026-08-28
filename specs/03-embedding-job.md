# 03 — Job de embeddings

## Estado
Implementado

Validado: 2026-08-27 — PASS 6/6 criterios. Ver `rag/specs/validations/03-embedding-job.validation.md`.

## Contexto y objetivo

La spec 02 deja chunks con `status='pending'` y `embedding=NULL`, y emite un evento `chunk.created` por cada uno. Esta spec implementa el listener que escucha ese evento, genera el embedding del `content` del chunk vía Ollama, lo persiste, y actualiza el estado agregado del documento padre cuando todos sus chunks terminan (exitosa o fallidamente). Al terminar esta spec, el pipeline completo "subir JSON → chunks embebidos y listos para búsqueda" queda funcionando de punta a punta (falta solo exponer la búsqueda, que es la spec 04).

## Diseño técnico

- Se crea `modules/ollama/ollama.provider.ts`: `OllamaProvider.embed(text: string): Promise<number[]>`, que llama a `POST ${OLLAMA_BASE_URL}/api/embed` con body `{ model: EMBEDDING_MODEL, input: text, dimensions: VECTOR_DIM }` (NO usar `/api/embeddings`, no soporta el parámetro `dimensions`) y devuelve `response.embeddings[0]`. Timeout configurable (ej. 30s), sin reintento automático en esta spec.
- `modules/embeddings/listeners/embed-chunk.listener.ts` escucha `chunk.created` (payload: `chunkId`):
  1. Crea una fila en `job_status` (`job_type='embedding'`, `chunk_id`, `document_id` del chunk, `status='processing'`, `started_at=now()`).
  2. Marca `chunks.status='processing'` para ese chunk.
  3. Llama a `OllamaProvider.embed(chunk.content)`.
  4. Si tiene éxito: guarda el vector en `chunks.embedding`, `chunks.status='done'`. Marca `job_status.status='done'`, `finished_at=now()`.
  5. Si falla (timeout, error HTTP, Ollama caído): `chunks.status='failed'`, `chunks.error_message` con el detalle; `job_status.status='failed'`, `error_message` con el detalle. No hay reintento automático — `job_status.attempts` queda en 1, disponible para una futura spec de reintentos manuales si se necesita.
- Tras procesar cada chunk (éxito o fallo), el listener revisa si quedan chunks del mismo `document_id` en estado `pending` o `processing`. Si no quedan: actualiza `documents.status` a `'done'` (si todos los chunks del documento terminaron en `'done'`) o `'failed'` (si al menos uno terminó en `'failed'`).
- Tracing: si Langfuse ya está disponible en este punto (ver spec 04, que es donde se integra formalmente para `/query`), esta spec puede omitir tracing propio — el tracing de Langfuse se centra en el flujo de `/query`, no en el pipeline de ingesta. No agregar Langfuse aquí si no aporta valor de negocio inmediato; puede añadirse después si Eder lo pide explícitamente.

## Contratos de API

N/A — esta spec no expone endpoints nuevos, es un listener interno disparado por eventos de la spec 02.

## Esquema de datos

No agrega tablas nuevas; usa `chunks.embedding`, `chunks.status`, `chunks.error_message`, `job_status` y `documents.status`, ya creados por la migración de la spec 02.

## Criterios de aceptación

1. Tras subir un documento con 3 tours (flujo de la spec 02) y esperar a que termine el procesamiento, las 3 filas de `chunks` para ese documento tienen `status='done'` y `embedding IS NOT NULL`.
2. `SELECT vector_dims(embedding) FROM chunks WHERE document_id = '<id>' LIMIT 1;` devuelve `1536` para cada chunk embebido.
3. `job_status` tiene 3 filas con `job_type='embedding'`, cada una con `chunk_id` distinto, `status='done'`.
4. `documents.status` pasa a `'done'` una vez que los 3 chunks terminaron exitosamente.
5. Si se detiene Ollama (o se apunta `OLLAMA_BASE_URL` a una URL inválida) antes de subir un documento: el chunk correspondiente termina con `chunks.status='failed'` y `error_message` no vacío; `job_status` de tipo `embedding` para ese chunk queda `status='failed'`; `documents.status` termina en `'failed'`. Ningún chunk queda indefinidamente en `'processing'`.
6. Reiniciar el proceso de la app NestJS a mitad de un batch grande no dejar filas de `job_status` en `'processing'` de forma permanente sin explicación — esto es una limitación conocida y aceptada (jobs en memoria, sin recuperación automática tras crash) que debe quedar documentada en la respuesta de validación, no necesariamente resuelta en código.

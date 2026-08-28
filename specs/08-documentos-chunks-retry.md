# 08 — Interfaz de documentos/chunks y reintento manual de embedding

## Estado
Implementado

Validado: 2026-08-27 — PASS 31/31 criterios. Ver `rag/specs/validations/08-documentos-chunks-retry.validation.md`.

**Confirmado por Eder (2026-08-27):** los 3 puntos pendientes se confirmaron con la opción recomendada, sin cambios de texto: (1) el límite de paginación recorta `limit` a 100 en silencio, sin HTTP 400, tal como ya estaba redactado en "Diseño técnico"; (2) el mensaje de UI para el caso límite de un documento `failed` con 0 chunks se deja tal cual ("Este documento no tiene chunks para reintentar; debe volver a subirse"); (3) el retry de chunking real y el bug de `job_status.attempts` quedan fuera de alcance de esta spec, tal como está documentado.

## Contexto y objetivo

Eder pidió (verbatim): "Elabora una interfaz donde se vean los chunks y los documentos. Por favor elabora opciones de reintento para intentar crear el embedding y chunkear solo si estos están en estado fallido."

Hoy, una vez subido un documento (spec 02), no existe ninguna forma de ver qué pasó con él ni con sus chunks salvo consultar la base de datos directamente — no hay `GET` de documentos ni de chunks, y no hay `ChunksController`. Tampoco existe ningún mecanismo de reintento: la spec 03 (`03-embedding-job.md`, línea 20) ya anticipaba esta necesidad explícitamente: *"No hay reintento automático — `job_status.attempts` queda en 1, disponible para una futura spec de reintentos manuales si se necesita."* Esta spec es esa spec futura.

**Alcance confirmado explícitamente por Eder** (pregunta directa, respondida en conversación): el reintento cubre **únicamente el embedding**, no el chunking. Dos variantes:
1. Reintentar un chunk individual en estado `failed`.
2. Reintentar de una sola vez todos los chunks `failed` de un documento.

**Fuera de alcance, documentado explícitamente (no es un olvido)**: el caso en que el *job de chunking* falla antes de crear un solo chunk — un documento queda `status='failed'` con 0 filas en `chunks`. No existe forma de reprocesar ese caso porque el JSON crudo del upload nunca se persiste (la spec 02 v2 solo persiste `raw_data` por chunk, una vez que el chunk ya existe; no hay tabla ni columna que guarde el array completo subido). Para ese caso, la única opción es volver a subir el archivo. Esta spec no agrega ningún mecanismo de "reintentar chunking" — el nombre del endpoint y la UI reflejan que el retry es de embedding, no de chunking, a pesar de que el pedido original de Eder mencionaba ambos.

Esta spec no modifica los contratos ya implementados de `POST /documents/upload` (spec 02) ni `POST /query` (spec 04) — agrega endpoints nuevos, de solo lectura y de reintento, todos bajo `DocumentsController` existente.

## Diseño técnico

### Por qué todo vive en `DocumentsController` / `DocumentsModule`

`DocumentsModule` ya importa `ChunksModule` (para inyectar `ChunksRepository`/`ChunksService` en `DocumentsService`, usados hoy en la validación de upload y en `finalizeStatusIfComplete`). Crear un `ChunksController` nuevo dentro de `ChunksModule` que necesite leer/escribir `documents` (para el 404 de "documento no existe" y el reset a `processing`) requeriría que `ChunksModule` importe `DocumentsModule` de vuelta — un ciclo de módulos. Por eso los 5 endpoints nuevos de esta spec se agregan a `DocumentsController`, y toda la orquestación vive en `DocumentsService`, que ya tiene inyectados `DocumentsRepository`, `ChunksRepository` y `EventEmitter2`. No se crea `ChunksController`.

### Endpoints nuevos (los 5, ver contratos completos abajo)

1. `GET /documents` — lista paginada de documentos.
2. `GET /documents/:id` — detalle de un documento.
3. `GET /documents/:id/chunks` — lista paginada de chunks de un documento.
4. `POST /documents/:documentId/chunks/:chunkId/retry` — reintento de un chunk individual.
5. `POST /documents/:id/retry-failed-chunks` — reintento de todos los chunks `failed` de un documento.

### Reutilización del pipeline de embedding existente sin modificarlo

El hallazgo clave (verificado en el código actual) es que **re-emitir `CHUNK_CREATED_EVENT`** (`rag/src/modules/chunks/chunks.events.ts`) con el `chunkId`/`documentId` de un chunk ya existente reutiliza el pipeline completo sin tocar una sola línea de `EmbedChunkListener` (`rag/src/modules/embeddings/listeners/embed-chunk.listener.ts`) ni de `EmbeddingsService`: ese listener no distingue "chunk recién creado por el job de chunking" de "chunk reseteado a `pending` por un retry manual" — simplemente crea una fila nueva en `job_status` (tipo `embedding`), marca el chunk `processing`, llama a Ollama, y en su bloque `finally` llama siempre a `documentsService.finalizeStatusIfComplete(documentId)`.

Por eso el retry, tanto individual como masivo, se implementa así:
1. Validar precondiciones (existencia, pertenencia, estado `failed`) — ver reglas por endpoint abajo.
2. **Resetear el estado en base de datos primero**: chunk → `status='pending', errorMessage=null`; documento → `status='processing'` (una sola vez, incluso si se resetean varios chunks).
3. **Recién después**, emitir `CHUNK_CREATED_EVENT({ chunkId, documentId })` por cada chunk reseteado.
4. Responder `202 Accepted` de inmediato — el procesamiento real (llamada a Ollama) ocurre de forma asíncrona en el listener existente, igual que en el flujo original de la spec 03.

**Orden de operaciones — requisito de diseño explícito, no opcional**: el reset en BD debe completarse *antes* de emitir el evento. Si se emitiera el evento primero, existe una condición de carrera real: `EmbedChunkListener` podría ejecutarse (incluyendo su `finally` con `finalizeStatusIfComplete`) antes de que el reset del documento a `processing` se haya persistido, lo cual podría dejar el documento en un estado inconsistente si justo en ese instante no quedan otros chunks pendientes. Reseteando primero se garantiza que, en el peor caso, el listener ve el estado ya correcto (`pending`/`processing`) en cualquier orden de ejecución.

### Nuevos métodos de repositorio (nombres exactos)

`DocumentsRepository` (`rag/src/modules/documents/documents.repository.ts`):
- `findAllPaginated(page: number, limit: number): Promise<{ items: Document[]; total: number }>` — `ORDER BY created_at DESC`, `OFFSET (page-1)*limit LIMIT limit`, más un `count()` total sin paginar.
- `markProcessing(id: string): Promise<void>` — análogo a `markDone`/`markFailed` ya existentes, hace `UPDATE documents SET status='processing' WHERE id=$1`.

`ChunksRepository` (`rag/src/modules/chunks/chunks.repository.ts`):
- `findByDocumentIdPaginated(documentId: string, page: number, limit: number): Promise<{ items: Chunk[]; total: number }>` — `WHERE document_id = $1 ORDER BY created_at ASC`, paginado igual que arriba.
- `findFailedIdsByDocumentId(documentId: string): Promise<string[]>` — `SELECT id FROM chunks WHERE document_id=$1 AND status='failed'`.
- `resetToPending(id: string): Promise<void>` — `UPDATE chunks SET status='pending', error_message=NULL, updated_at=now() WHERE id=$1`.

Estos métodos no reemplazan ni modifican ninguno de los ya existentes (`create`, `findById`, `markProcessing` de chunk, `markEmbeddingDone`, `markFailed`, `countUnfinishedByDocumentId`, `countFailedByDocumentId`, `findNearest`).

### DTOs de paginación

Siguiendo el patrón exacto ya usado en `rag/src/modules/query/dto/query-request.dto.ts` (`@IsOptional() @Type(() => Number) @IsInt() @IsPositive()`), se crea un DTO de query params reutilizable, por ejemplo `dto/pagination-query.dto.ts`:

```ts
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  page?: number; // default 1

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  limit?: number; // default 20, tope 100
}
```

El tope de `limit=100` se aplica en el servicio (`Math.min(limit ?? 20, 100)`), no en el DTO — un `limit=500` no debe rechazarse con 400, simplemente se recorta a 100 silenciosamente (mismo criterio de tolerancia que otros límites del proyecto, ej. `MAX_UPLOAD_ITEMS` sí rechaza porque es un límite de integridad, pero aquí es solo un límite de presentación).

### Frontend

Nuevo componente `DocumentsView.tsx` (`rag/frontend/src/components/DocumentsView.tsx`), insertado en `App.tsx` entre `UploadView` y `AskView`:

```tsx
<UploadView />
<DocumentsView />
<AskView />
```

El proyecto no tiene router (confirmado: `App.tsx` solo apila componentes) y esta spec no lo introduce — `DocumentsView` es una sección más de la misma página, no una ruta separada.

**Datos de red (React Query, primer uso de `useQuery` en el proyecto — hasta ahora solo `useMutation`):**
- Tabla de documentos: `useQuery({ queryKey: ['documents', page], queryFn: () => getDocuments(page) })`.
- `refetchInterval` condicional: sigue haciendo polling (cada 3000ms) mientras algún documento de la página actual tenga `status` en `pending` o `processing`; se detiene (`refetchInterval: false`) cuando todos los documentos listados están en `done` o `failed`.
- Fila expandible: estado `expandedDocumentId: string | null` vive en Zustand (`useAppStore`, `rag/frontend/src/store/appStore.ts`) — es estado de interacción de UI, no datos de red, consistente con el comentario ya existente en ese archivo ("El estado de red vive en los hooks de React Query… Zustand solo guarda estado de interacción").
- Sub-tabla de chunks: `useQuery({ queryKey: ['documentChunks', documentId, chunksPage], queryFn: () => getDocumentChunks(documentId, chunksPage), enabled: expandedDocumentId !== null })`, mismo patrón de `refetchInterval` condicional basado en el estado de los chunks listados.
- Ambas queries de lista usan `placeholderData: keepPreviousData` (de `@tanstack/react-query`) para evitar parpadeo visual al paginar o al refetchear por polling.

**Mutaciones de retry:**
- `useMutation({ mutationFn: () => retryChunk(documentId, chunkId) })`, botón "Reintentar" visible únicamente si `chunk.status === 'failed'`.
- `useMutation({ mutationFn: () => retryFailedChunks(documentId) })`, botón "Reintentar fallidos" visible únicamente si `document.status === 'failed'`.
- Ambas invalidan en `onSuccess`: `queryClient.invalidateQueries({ queryKey: ['documents'] })` y `queryClient.invalidateQueries({ queryKey: ['documentChunks', documentId] })`.
- Caso límite de UI: si `document.status === 'failed'` pero la petición a `retry-failed-chunks` devuelve 409 (documento sin chunks — chunking falló antes de crear el primero), la UI muestra el mensaje "Este documento no tiene chunks para reintentar; debe volver a subirse" en vez de un botón que reintenta indefinidamente sin efecto. No se oculta el botón de antemano (no hay forma barata de saber "0 chunks totales" sin una llamada extra) — se maneja como resultado de la mutación fallida.

**Archivos nuevos/modificados en frontend:**
- `rag/frontend/src/api/chunks.ts` (nuevo): `getDocumentChunks(documentId, page, limit?)`, `retryChunk(documentId, chunkId)` — mismo patrón try/catch + `ApiError` que `uploadTours` en `rag/frontend/src/api/documents.ts`.
- `rag/frontend/src/api/documents.ts` (ampliado): `getDocuments(page, limit?)`, `getDocument(id)`, `retryFailedChunks(documentId)`.
- `rag/frontend/src/api/types.ts` (ampliado): `DocumentListItemDto`, `ChunkListItemDto`, `PaginatedResponse<T>`, `RetryChunkResponse`, `RetryFailedChunksResponse` — reflejando exactamente los contratos de esta spec, sin campos inventados (mismo criterio que el comentario ya presente al inicio de ese archivo).
- `rag/frontend/src/main.tsx`: se agrega `queries: { retry: false }` al `defaultOptions` del `QueryClient` (hoy solo existe para `mutations`) — sin esto, las queries nuevas heredarían el default de React Query v5 de 3 reintentos automáticos con backoff, comportamiento no deseado para un panel de administración donde un error debe mostrarse de inmediato.
- `rag/frontend/src/index.css`: estilos nuevos — tabla genérica reutilizable, badges de estado reutilizando las variables ya existentes `--info-bg/border/text` (para `pending` y `processing`, que comparten tratamiento visual), `--success-bg/border/text` (para `done`), `--error-bg/border/text` (para `failed`), wrapper de sub-tabla expandible, controles de paginación simples (anterior/siguiente + "página X de Y"), y estilo para el mensaje de error por chunk (`chunk.errorMessage`).

## Contratos de API

Todos los endpoints devuelven `application/json`. Ninguno requiere autenticación (spec 00: sin autenticación).

### 1. `GET /documents?page=&limit=`

Request:
```
GET /documents?page=1&limit=20
```

Response — `200 OK`:
```json
{
  "items": [
    {
      "id": "b3f1c2a0-1111-4a2b-9c3d-000000000001",
      "originalFilename": "tours-medellin.json",
      "totalItems": 12,
      "status": "done",
      "createdAt": "2026-08-27T14:00:00.000Z",
      "updatedAt": "2026-08-27T14:00:32.000Z"
    },
    {
      "id": "b3f1c2a0-1111-4a2b-9c3d-000000000002",
      "originalFilename": "productos.json",
      "totalItems": 2,
      "status": "failed",
      "createdAt": "2026-08-27T13:50:00.000Z",
      "updatedAt": "2026-08-27T13:50:12.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 2,
  "totalPages": 1
}
```

### 2. `GET /documents/:id`

Response — `200 OK` (mismo shape que un item de la lista):
```json
{
  "id": "b3f1c2a0-1111-4a2b-9c3d-000000000001",
  "originalFilename": "tours-medellin.json",
  "totalItems": 12,
  "status": "done",
  "createdAt": "2026-08-27T14:00:00.000Z",
  "updatedAt": "2026-08-27T14:00:32.000Z"
}
```

Response — `404 Not Found` (id no existe o no es un UUID válido):
```json
{
  "statusCode": 404,
  "message": "Documento b3f1c2a0-... no encontrado"
}
```

### 3. `GET /documents/:id/chunks?page=&limit=`

Response — `200 OK`:
```json
{
  "items": [
    {
      "id": "c1a2b3c4-2222-4a2b-9c3d-000000000001",
      "documentId": "b3f1c2a0-1111-4a2b-9c3d-000000000002",
      "content": "sku: ABC-123. titulo: Silla ergonómica. precio: 450000.",
      "status": "failed",
      "errorMessage": "Timeout al llamar a Ollama tras 30000ms",
      "createdAt": "2026-08-27T13:50:01.000Z",
      "updatedAt": "2026-08-27T13:50:11.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1,
  "totalPages": 1
}
```

**Nunca** se incluyen `rawData` ni `embedding` en esta respuesta — solo los campos listados arriba.

Response — `404 Not Found` si `:id` no corresponde a un documento existente (mismo formato que el punto 2).

### 4. `POST /documents/:documentId/chunks/:chunkId/retry`

Request: sin body.
```
POST /documents/b3f1c2a0-.../chunks/c1a2b3c4-.../retry
```

Response — `202 Accepted`:
```json
{
  "chunkId": "c1a2b3c4-2222-4a2b-9c3d-000000000001",
  "documentId": "b3f1c2a0-1111-4a2b-9c3d-000000000002",
  "status": "pending"
}
```

Response — `404 Not Found` (documento no existe, chunk no existe, o el chunk no pertenece al `documentId` de la URL):
```json
{
  "statusCode": 404,
  "message": "Chunk c1a2b3c4-... no encontrado para el documento b3f1c2a0-..."
}
```

Response — `409 Conflict` (chunk existe pero no está en `failed`):
```json
{
  "statusCode": 409,
  "message": "El chunk c1a2b3c4-... está en estado 'done', solo se puede reintentar si está en 'failed'"
}
```

### 5. `POST /documents/:id/retry-failed-chunks`

Request: sin body.
```
POST /documents/b3f1c2a0-.../retry-failed-chunks
```

Response — `202 Accepted`:
```json
{
  "documentId": "b3f1c2a0-1111-4a2b-9c3d-000000000002",
  "retriedCount": 2,
  "status": "processing"
}
```

Response — `404 Not Found` (documento no existe):
```json
{
  "statusCode": 404,
  "message": "Documento b3f1c2a0-... no encontrado"
}
```

Response — `409 Conflict` (documento existe pero no tiene ningún chunk en `failed` — incluye el caso límite documentado de un documento `failed` con 0 chunks):
```json
{
  "statusCode": 409,
  "message": "El documento b3f1c2a0-... no tiene chunks en estado 'failed' para reintentar"
}
```

## Esquema de datos

Esta spec **no crea ni modifica columnas ni tablas**. Reutiliza exactamente el esquema ya existente de `documents`, `chunks` y `job_status` (definido en la spec 01 y ajustado por la spec 02 v2):

```sql
-- documents (sin cambios)
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_filename TEXT NOT NULL,
  total_items INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|processing|done|failed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- chunks (esquema tras spec 02 v2, sin cambios)
CREATE TABLE chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  raw_data JSONB NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|processing|done|failed
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- job_status (sin cambios; cada retry crea una fila nueva de tipo 'embedding',
-- igual que el flujo original de la spec 03 — no se reutiliza ni se edita
-- la fila del intento fallido anterior)
```

No se agrega ninguna columna de "número de reintentos" a `chunks` ni `documents` en esta spec — el conocido bug de `job_status.attempts` (siempre en 0, documentado en la spec 03) queda explícitamente fuera de alcance, no se toca.

## Criterios de aceptación

**Listado de documentos**

1. Con al menos 2 documentos existentes, `curl -s http://localhost:3000/documents` devuelve HTTP 200 con `items` (array), `page=1`, `limit=20`, `total>=2`, `totalPages>=1`, ordenado por `createdAt` descendente (el más reciente primero).
2. `curl -s "http://localhost:3000/documents?page=1&limit=1"` con al menos 2 documentos devuelve `items.length===1` y `totalPages>=2`.
3. `curl -s "http://localhost:3000/documents?limit=500"` no devuelve HTTP 400 — responde 200 con como máximo 100 items (tope silencioso documentado en "Diseño técnico").
4. `curl -s "http://localhost:3000/documents?page=0"` o `?page=-1` devuelve HTTP 400 (violación de `@IsPositive()` del DTO).

**Detalle de documento**

5. `curl -s http://localhost:3000/documents/<id-existente>` devuelve HTTP 200 con el shape exacto documentado (`id, originalFilename, totalItems, status, createdAt, updatedAt`).
6. `curl -s http://localhost:3000/documents/00000000-0000-0000-0000-000000000000` (UUID válido pero inexistente) devuelve HTTP 404.

**Listado de chunks de un documento**

7. Para un documento con 3 chunks, `curl -s http://localhost:3000/documents/<id>/chunks` devuelve HTTP 200 con `items.length===3`, ordenados por `createdAt` ascendente, y cada item con `id, documentId, content, status, errorMessage, createdAt, updatedAt` — verificado por inspección de las claves del JSON que **no** incluye `rawData` ni `embedding`.
8. `curl -s http://localhost:3000/documents/00000000-0000-0000-0000-000000000000/chunks` (documento inexistente) devuelve HTTP 404.
9. Paginación de chunks (`?page=&limit=`) se comporta igual que la de documentos (criterios 2-4 aplicados a este endpoint).

**Retry de chunk individual**

10. Provocar un fallo de embedding real (deteniendo Ollama o apuntando `OLLAMA_BASE_URL` a una URL inválida, como en el criterio 5 de la spec 03) y subir un documento de 1 item: el chunk termina `status='failed'` con `errorMessage` no vacío, y el documento termina `status='failed'`.
11. Con Ollama restaurado, `curl -i -X POST http://localhost:3000/documents/<docId>/chunks/<chunkId>/retry` devuelve HTTP 202 con `{chunkId, documentId, status:'pending'}`.
12. Inmediatamente tras el 202 del criterio 11, `SELECT status, error_message FROM chunks WHERE id='<chunkId>'` muestra `status IN ('pending','processing')` y `error_message IS NULL` (reset ya aplicado antes de que termine el reprocesamiento asíncrono).
13. Esperando el reprocesamiento asíncrono (unos segundos), el chunk termina `status='done'`, `embedding IS NOT NULL`, y el documento vuelve a `status='done'` (vía `finalizeStatusIfComplete`, sin cambios de código en ese método).
14. `job_status` tiene una fila **nueva** de tipo `embedding` para ese `chunk_id` con `status='done'` — la fila del intento fallido original sigue existiendo con `status='failed'` (no se sobreescribe ni se borra).
15. `curl -i -X POST http://localhost:3000/documents/<docId>/chunks/<chunkId>/retry` sobre un chunk en `status='done'` devuelve HTTP 409 con mensaje que incluye el estado actual (`'done'`).
16. `curl -i -X POST http://localhost:3000/documents/<docIdA>/chunks/<chunkIdDeOtroDocumento>/retry` (chunk existente pero perteneciente a un documento distinto al de la URL) devuelve HTTP 404.
17. `curl -i -X POST http://localhost:3000/documents/00000000-0000-0000-0000-000000000000/chunks/<cualquier-uuid>/retry` devuelve HTTP 404.

**Retry masivo por documento**

18. Provocar que un documento termine con al menos 2 chunks en `failed` (deteniendo Ollama durante el embedding de un documento de 2+ items) y luego restaurar Ollama. `curl -i -X POST http://localhost:3000/documents/<docId>/retry-failed-chunks` devuelve HTTP 202 con `{documentId, retriedCount:2, status:'processing'}`.
19. Inmediatamente tras el 202 del criterio 18, `SELECT status FROM documents WHERE id='<docId>'` muestra `'processing'`, y los 2 chunks antes `failed` muestran `status IN ('pending','processing')` con `error_message IS NULL`.
20. Esperando el reprocesamiento, ambos chunks terminan `status='done'` y el documento vuelve a `status='done'`.
21. `curl -i -X POST http://localhost:3000/documents/<docId>/retry-failed-chunks` sobre un documento sin ningún chunk en `failed` (ej. `status='done'`) devuelve HTTP 409.
22. **Caso límite explícito**: para un documento `status='failed'` con 0 filas en `chunks` (simulable manualmente insertando un documento vía SQL directo con `status='failed'` y sin chunks asociados, ya que este caso no es reproducible disparando el flujo real de upload en un entorno sano), `curl -i -X POST http://localhost:3000/documents/<docId>/retry-failed-chunks` devuelve HTTP 409 — mismo comportamiento que el criterio 21, comportamiento esperado y no un bug.
23. `curl -i -X POST http://localhost:3000/documents/00000000-0000-0000-0000-000000000000/retry-failed-chunks` devuelve HTTP 404.

**Frontend**

24. Con el backend y frontend corriendo, al abrir la UI se ve la sección de documentos (`DocumentsView`) entre la sección de upload y la de preguntas, mostrando la tabla de documentos con columnas nombre de archivo, total de items, estado (badge de color) y fecha.
25. El badge de estado usa el color "info" para `pending`/`processing`, "success" (verde) para `done`, "error" (rojo) para `failed` — verificable inspeccionando las clases CSS aplicadas en el DOM.
26. Al hacer clic en una fila de documento, se expande y muestra la sub-tabla de sus chunks (contenido, estado, mensaje de error si aplica).
27. Subir un documento nuevo y, mientras su estado es `processing`, observar en las DevTools (pestaña Network) que la tabla de documentos hace polling (petición `GET /documents` repetida cada ~3 segundos); una vez que el documento pasa a `done`/`failed`, el polling se detiene (no hay más peticiones `GET /documents` automáticas tras ese punto, solo las disparadas por interacción manual).
28. El botón "Reintentar" en una fila de chunk es visible únicamente cuando `chunk.status === 'failed'` — no aparece para chunks en `pending`, `processing` ni `done` (verificable inspeccionando el DOM en cada estado).
29. El botón "Reintentar fallidos" a nivel de documento es visible únicamente cuando `document.status === 'failed'` — no aparece para documentos en `pending`, `processing` ni `done`.
30. Al hacer clic en "Reintentar" (individual o masivo) contra un backend con Ollama restaurado, tras la respuesta 202 la UI dispara nuevas peticiones `GET /documents` y `GET /documents/:id/chunks` (invalidación de queries) y refleja el nuevo estado (`pending`/`processing`) sin necesidad de recargar la página manualmente.
31. Si se intenta "Reintentar fallidos" sobre un documento `failed` con 0 chunks (ver criterio 22), la UI muestra el mensaje "Este documento no tiene chunks para reintentar; debe volver a subirse" en lugar de un error genérico o un estado de carga colgado.

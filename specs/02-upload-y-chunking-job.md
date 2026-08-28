# 02 — Bootstrap NestJS + Upload y job de chunking

## Estado
Implementado

Validado: 2026-08-27 — PASS 9/9 criterios. Ver `rag/specs/validations/02-upload-y-chunking-job.validation.md`.

**Superada por `02-upload-y-chunking-job-v2.md` (Implementado, validada 2026-08-27 — PASS 14/14 criterios).** Eder pidió eliminar la restricción de schema fijo de "tour" (`nombre`, `descripcion`, `precio_publico`, `precio_dolar`, `lugar_embarque`, `lugar`, `ciudad`); v2 reemplaza la validación de entrada, la construcción de `content` y el esquema de la tabla `chunks` (columnas de tour → `raw_data JSONB`) descritos en este documento. Este archivo se conserva íntegro como registro histórico de lo implementado y validado originalmente; ver la sección "Delta respecto a v1" de v2 para el detalle exacto de qué criterios de aceptación de este documento siguen vigentes sin cambios y cuáles fueron reemplazados.

## Contexto y objetivo

Esta es la primera spec que produce código de aplicación. Cubre tres cosas relacionadas: (1) el bootstrap del proyecto NestJS en `rag/src/` con la conexión a Postgres, (2) la migración de TypeORM que crea el esquema completo ya documentado en `00-arquitectura-general.md` (tablas `documents`, `chunks`, `job_status` + índice HNSW — nada de esto existe todavía, spec 01 deliberadamente no lo creó), y (3) el endpoint `POST /documents/upload` con su job de chunking en background.

"Chunking" aquí es simple por diseño: cada objeto del array JSON subido **es** un chunk — no hay que partir texto largo. El trabajo del job de chunking es: validar el archivo, crear una fila en `documents`, y por cada objeto del array crear una fila en `chunks` con un campo `content` (texto concatenado legible) listo para ser embebido. Al terminar cada chunk se emite un evento `chunk.created` que la spec 03 (embedding job) consume — esta spec NO genera embeddings, `chunks.embedding` queda `NULL` y `chunks.status='pending'` al terminar.

## Diseño técnico

### Bootstrap del proyecto

- `rag/` pasa a tener su propio `package.json`, `tsconfig.json`, `nest-cli.json` — proyecto NestJS independiente del sitio web principal.
- Estructura de `rag/src/` tal como está documentada en `00-arquitectura-general.md` (se crean en esta spec los módulos `config`, `database`, `modules/documents`, `modules/chunks`, `modules/jobs`, `health`; los módulos `embeddings`, `query`, `ollama`, `langfuse` se crean en specs posteriores aunque `ollama.provider.ts` con el método `embed()` puede adelantarse aquí si `chunks` ya no lo necesita — no, `chunks` no llama a Ollama, así que `ollama.provider.ts` se crea recién en la spec 03).
- `@nestjs/config` con validación de variables de entorno (usar `Joi` o `zod`) — la app no debe arrancar si faltan variables de Postgres requeridas.
- `TypeOrmModule` conectado a Postgres usando las variables `POSTGRES_*` de `rag/.env.example` (ya existe, de la spec 01).

### Migración inicial de TypeORM

- `rag/src/database/migrations/<timestamp>-InitialSchema.ts` — única fuente de verdad del esquema de aplicación (ver Esquema de datos abajo). Como TypeORM no tiene un tipo `vector` nativo, la migración usa `queryRunner.query(...)` con SQL raw para la columna `embedding VECTOR(1536)` y el índice `USING hnsw (embedding vector_cosine_ops)`.
- `VECTOR_DIM` se lee de la config al generar la migración (valor usado: 1536, ver `00-arquitectura-general.md`); si cambia en el futuro, se documenta como limitación conocida que exige una migración nueva + re-embeber.
- Comando de aplicación: `npm run migration:run` (script en `package.json`).

### Endpoint y job de chunking

- `POST /documents/upload` — `multipart/form-data`, campo de archivo `file` (JSON, tamaño máximo razonable vía límite de Multer, ej. 10MB).
- Validación síncrona en el request (antes de crear cualquier fila): el archivo debe parsear como JSON y ser un array; cada elemento se valida contra `TourItemDto` (`class-validator`): `nombre` (string, requerido), `descripcion` (string, opcional), `precio_publico` (number, opcional), `precio_dolar` (number, opcional), `lugar_embarque` (string, opcional), `lugar` (string, opcional), `ciudad` (string, opcional). Si el JSON es inválido o cualquier elemento falla la validación, se rechaza **todo el batch** con 400 y no se crea ninguna fila — no hay éxito parcial silencioso.
- Si la validación pasa: se crea la fila en `documents` (`status='processing'`, `total_items=<longitud del array>`), se emite el evento `document.uploaded` (payload: `documentId`, array de items ya validados), y el endpoint responde **HTTP 202** de inmediato sin esperar a que termine el chunking (procesamiento asíncrono en background).
- Listener `DocumentUploadedListener` (en `modules/chunks`), escucha `document.uploaded`:
  1. Crea una fila en `job_status` (`job_type='chunking'`, `document_id`, `chunk_id=NULL`, `status='processing'`, `started_at=now()`).
  2. Por cada item del array, en orden: construye `content` como texto legible (ej. `"Tour: {nombre}. Descripción: {descripcion}. Precio: {precio_publico} COP / {precio_dolar} USD. Lugar de embarque: {lugar_embarque}. Lugar: {lugar}, {ciudad}."`, omitiendo campos vacíos), inserta la fila en `chunks` (`status='pending'`, `embedding=NULL`), y emite `chunk.created` con el `chunkId`.
  3. Al terminar todos los items, marca la fila `job_status` de tipo `chunking` como `status='done'`, `finished_at=now()`. Si algo falla a mitad de camino, la marca `status='failed'` con `error_message` y dejar de procesar el resto (no hay reintento automático en esta spec).
  4. El `documents.status` permanece `'processing'` tras esta spec (pasa a `'done'`/`'failed'` recién cuando la spec 03 termine de embeber todos los chunks).

## Contratos de API

**Request** — `POST /documents/upload`, `multipart/form-data`:
```
file: tours.json   (application/json, array de objetos tour)
```

Ejemplo de contenido de `tours.json`:
```json
[
  {
    "nombre": "Tour Guatapé + Peñol",
    "descripcion": "Recorrido por el pueblo de Guatapé y subida al Peñol",
    "precio_publico": 180000,
    "precio_dolar": 45,
    "lugar_embarque": "Hotel en Medellín",
    "lugar": "Guatapé",
    "ciudad": "Medellín"
  }
]
```

**Response — éxito (HTTP 202):**
```json
{
  "documentId": "b3f1...-uuid",
  "totalItems": 1,
  "status": "processing"
}
```

**Response — error de validación (HTTP 400):**
```json
{
  "statusCode": 400,
  "message": "El item en la posición 2 no tiene el campo requerido 'nombre'",
  "errors": [ { "index": 2, "field": "nombre", "constraint": "..." } ]
}
```

## Esquema de datos

Migración `InitialSchema` crea exactamente lo documentado en `00-arquitectura-general.md`:

```sql
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_filename TEXT NOT NULL,
  total_items INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  precio_publico NUMERIC,
  precio_dolar NUMERIC,
  lugar_embarque TEXT,
  lugar TEXT,
  ciudad TEXT,
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX chunks_document_id_idx ON chunks (document_id);
CREATE INDEX chunks_status_idx ON chunks (status);
CREATE INDEX chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE job_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_id UUID REFERENCES chunks(id) ON DELETE CASCADE,
  job_type VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Criterios de aceptación

1. `npm run migration:run` aplica la migración sin error; `\dt` en psql lista `documents`, `chunks`, `job_status`; `\d chunks` muestra `embedding` como `vector(1536)`; `\di chunks_embedding_hnsw_idx` confirma el índice HNSW.
2. `POST /documents/upload` con un archivo JSON válido de 3 tours devuelve HTTP 202 con `documentId` (UUID) y `totalItems=3`.
3. Segundos después, la tabla `chunks` tiene exactamente 3 filas con `document_id` igual al `documentId` devuelto, cada una con `status='pending'`, `embedding IS NULL`, y `content` no vacío.
4. `job_status` tiene exactamente 1 fila con `job_type='chunking'`, `document_id` igual al del documento, `chunk_id IS NULL`, `status='done'`.
5. El campo `content` de una fila de `chunks` contiene, en texto legible, el nombre, descripción y precio del tour correspondiente (verificación por inspección directa de una fila).
6. `POST /documents/upload` con un archivo que no es JSON válido devuelve HTTP 400 y no crea ninguna fila en `documents` ni `chunks`.
7. `POST /documents/upload` con un array donde un item no tiene `nombre` devuelve HTTP 400 identificando el índice/campo, y no crea ninguna fila (ni siquiera para los items válidos del mismo array).
8. `POST /documents/upload` sin el campo `file` devuelve HTTP 400.
9. `documents.status` de un documento recién subido es `'processing'` inmediatamente después de la respuesta 202 (no cambia a `'done'` en esta spec — eso depende de la spec 03).

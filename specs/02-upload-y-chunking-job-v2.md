# 02 — Bootstrap NestJS + Upload y job de chunking (v2 — schema arbitrario)

## Estado
Implementado

Validado: 2026-08-27 — PASS 14/14 criterios. Ver `rag/specs/validations/02-upload-y-chunking-job-v2.validation.md`.

**Confirmado por Eder (2026-08-27):** las 3 preguntas abiertas de esta spec quedan resueltas, siguiendo la recomendación de esta spec en los 3 casos:
1. **Datos existentes (12 documents / 24 chunks de prueba):** son datos de prueba, no hay catálogo de producción real que preservar. Se procede con la migración destructiva de columnas (`DROP COLUMN nombre/descripcion/precio_publico/precio_dolar/lugar_embarque/lugar/ciudad`) sin backfill de `raw_data` para las filas viejas, tal como describe la sección "Nota sobre datos existentes". Si se quiere `raw_data` poblado en el catálogo de prueba actual, se re-sube el mismo JSON después del deploy — acción operativa, no criterio de aceptación.
2. **Límites de upload:** aceptados tal cual quedaron propuestos — `MAX_UPLOAD_ITEMS=2000`, `MAX_ITEM_DEPTH=6`, `MAX_ITEM_SIZE_BYTES=100000` (~100KB). Sin cambios a los defaults documentados en "Esquema de datos".
3. **Rechazo de batch:** se mantiene el rechazo total del batch completo si cualquier item es inválido (mismo comportamiento que v1) — no se implementa éxito parcial ni skip de items inválidos.

Con esto, la spec queda lista para implementación por `nestjs-rag-developer`.

## Contexto y objetivo

`02-upload-y-chunking-job.md` (v1, `Implementado`, validado 2026-08-27) fue diseñada asumiendo que cada objeto del array subido tiene exactamente la forma de un "tour" del negocio (`nombre`, `descripcion`, `precio_publico`, `precio_dolar`, `lugar_embarque`, `lugar`, `ciudad` — ver también la sección "Esquema de 'tour' subido" de `00-arquitectura-general.md`). Eder pidió explícitamente remover esa restricción: **`POST /documents/upload` debe aceptar un array JSON de objetos con cualquier forma**, no solo tours. Esto es un cambio de contrato y de diseño, no un fix — por eso se versiona como `-v2` en vez de sobrescribir la spec original, siguiendo la convención del proyecto.

Esta spec v2 reemplaza, para el comportamiento futuro, las partes de v1 relacionadas con validación de schema, construcción de `content` y el esquema de la tabla `chunks`. No reemplaza la spec 02 v1 como documento histórico: v1 sigue existiendo para que quede registro de qué se implementó y validó originalmente, y esta v2 dice explícitamente qué criterios de v1 siguen vigentes y cuáles cambian (sección "Delta respecto a v1" más abajo).

**Alcance NO incluido en esta spec** (queda igual que v1, sin cambios): bootstrap de NestJS, conexión a Postgres, tablas `documents` y `job_status`, el evento `document.uploaded` → `chunk.created`, el endpoint respondiendo HTTP 202 de inmediato con procesamiento en background, y todo el flujo de la spec 03 (embedding) y spec 04 (query) — ninguno de esos dos depende de campos fijos de tour, se confirmó leyendo el código actual (`query.service.ts`, `chunks.repository.ts`: `findNearest` solo selecciona `id`, `content`, `distance`; el contexto para el chat model se arma concatenando `content`). Ver sección "Impacto en specs downstream" para el detalle de esa verificación.

## Diseño técnico

### 1. Validación de entrada (reemplaza `TourItemDto`)

Sin schema fijo, `class-validator` con un DTO de campos específicos ya no aplica. Se reemplaza por validación **estructural**, no de contenido de negocio:

- El archivo debe parsear como JSON (igual que v1 — sin cambios).
- El JSON parseado debe ser un **array** (igual que v1).
- El array **no puede estar vacío** — nuevo requisito explícito (en v1 quedaba implícito/no probado). Un array vacío se rechaza con 400: "El archivo debe contener al menos un elemento".
- El array no puede tener más de `MAX_UPLOAD_ITEMS` elementos (env, default `2000`) — protección básica contra archivos absurdamente grandes que satures memoria/DB en un solo batch. Si se excede: 400 con el conteo recibido y el máximo permitido.
- Cada elemento debe ser un **objeto JSON plano**: `typeof item === 'object' && item !== null && !Array.isArray(item)`. Un elemento que sea string, number, boolean, null o array se rechaza.
- Cada elemento no puede exceder `MAX_ITEM_DEPTH` (env, default `6`) niveles de anidamiento (objetos/arrays anidados dentro de objetos/arrays) — protección contra JSON patológico diseñado para reventar un flatten recursivo (profundidad artificial, no bloques legítimos de negocio; 6 niveles es generoso para cualquier catálogo real).
- Cada elemento, serializado de nuevo con `JSON.stringify`, no puede exceder `MAX_ITEM_SIZE_BYTES` (env, default `100000` = ~100KB) — protección contra un solo objeto gigantesco (ej. un string de varios MB embebido en un campo) que degradaría la calidad del embedding de todas formas (Ollama no está pensado para embeber documentos enormes como un solo chunk).
- Cada elemento debe producir **contenido no vacío** al aplicar el flatten descrito en la sección 2 — un objeto vacío `{}` o un objeto donde todos los valores son `null`/`undefined`/string vacío no aporta nada embebible y se rechaza.
- **Se mantiene la regla de v1**: si *cualquier* elemento del array falla alguna de estas validaciones, se rechaza el **batch completo** con HTTP 400, identificando el índice del primer elemento inválido (y, cuando aplique, todos los índices inválidos en `errors[]`, igual que v1) — no hay éxito parcial silencioso. Se decide mantener esta regla porque es el mismo comportamiento ya validado y esperado por Eder en v1; cambiarla sería una decisión adicional no pedida.

Esto reemplaza `TourItemDto` (`dto/tour-item.dto.ts`, se elimina) por un validador estructural (ej. `dto/upload-item-validator.ts` o lógica directamente en `DocumentsService`, decisión de implementación libre para `nestjs-rag-developer`). El tipo del payload deja de ser `TourItemDto[]` y pasa a ser `Record<string, unknown>[]`.

### 2. Construcción de `content` para el embedding (reemplaza `ChunksService.buildContent`)

**Decisión recomendada: aplanar cada objeto a texto `clave: valor`, recursivamente, sin asumir ningún nombre de campo.**

Algoritmo:
1. Recorrer el objeto recursivamente. Para cada par `clave: valor`:
   - Si `valor` es `null`/`undefined`/string vacío: omitir (no aporta texto).
   - Si `valor` es primitivo (string, number, boolean): emitir la línea `"<claveCompleta>: <valor>."` — `<claveCompleta>` usa notación de punto para anidamiento, ej. `ubicacion.ciudad`.
   - Si `valor` es un objeto: recursar con `<claveCompleta>` como nuevo prefijo (`ubicacion.ciudad`, `ubicacion.pais`).
   - Si `valor` es un array de primitivos: emitir `"<claveCompleta>: <v1>, <v2>, <v3>."` (join por coma).
   - Si `valor` es un array de objetos: recursar cada elemento con prefijo `<claveCompleta>[i]` (ej. `servicios[0].nombre: Transporte.`).
2. Unir todas las líneas con un espacio, en el mismo orden en que aparecen las claves en el JSON original (`Object.keys` preserva el orden de inserción de `JSON.parse`, no hace falta ordenar alfabéticamente).

Ejemplo — item de tour (compatibilidad con el schema viejo, sigue funcionando igual de bien):
```json
{ "nombre": "Tour Guatapé + Peñol", "precio_publico": 180000, "ciudad": "Medellín" }
```
→ `content`: `"nombre: Tour Guatapé + Peñol. precio_publico: 180000. ciudad: Medellín."`

Ejemplo — item de un catálogo completamente distinto (ej. producto de e-commerce):
```json
{ "sku": "ABC-123", "titulo": "Silla ergonómica", "precio": 450000, "specs": { "color": "negro", "material": "malla" } }
```
→ `content`: `"sku: ABC-123. titulo: Silla ergonómica. precio: 450000. specs.color: negro. specs.material: malla."`

**Por qué esta opción y no las alternativas:**
- **JSON crudo como `content`** (`JSON.stringify(item)`): se descarta — las llaves, comillas y corchetes del JSON son ruido sintáctico para el modelo de embeddings y para el chat model al usarlo como contexto; degrada tanto la similitud semántica como la legibilidad de la respuesta del LLM.
- **Heurística de "buscar un campo título/nombre si existe"**: se descarta como base del diseño — no generaliza (muchos schemas no tendrán ningún campo así) y sesga la calidad de la búsqueda hacia el catálogo de tours, exactamente lo que Eder pidió eliminar. El flatten clave:valor ya incluye cualquier campo que actúe como título de forma natural (aparece como línea `nombre: ...` o `titulo: ...` o lo que sea, con su propio peso semántico), sin necesitar adivinar cuál es.
- El flatten preserva **el nombre del campo junto al valor**, lo cual ayuda a la búsqueda semántica: una pregunta como "¿cuánto cuesta el sku ABC-123?" tiene más probabilidad de matchear contra `"sku: ABC-123. ... precio: 450000."` que contra un blob de JSON crudo.

Esta función de flatten es de propósito general (no vive en `ChunksService` amarrada a tours) — se sugiere nombrarla `flattenToText(obj: Record<string, unknown>): string` en `modules/chunks/chunks.service.ts`, reemplazando `buildContent(item: TourItemDto)`.

### 3. Esquema de datos: `chunks` deja de tener columnas fijas de tour

Se reemplazan las 7 columnas específicas de tour por una sola columna `raw_data JSONB NOT NULL`, que guarda el objeto **exactamente como vino en el JSON subido** (sin transformar), disponible para:
- Debugging (ver el item original que generó un chunk).
- Uso futuro no cubierto por esta spec (ej. mostrar el item original en el frontend, filtros estructurados) — no se implementa consumo de `raw_data` en esta spec, solo se persiste.

La columna `content` (TEXT NOT NULL) se mantiene sin cambios de tipo — sigue siendo el texto plano usado para el embedding (spec 03) y como contexto del chat model (spec 04), ahora generado por `flattenToText` en vez de `buildContent`.

Nueva migración de TypeORM (no se edita la migración `InitialSchema` ya aplicada — TypeORM no permite reescribir migraciones ya corridas en un entorno con historial):

```sql
-- up
ALTER TABLE chunks
  DROP COLUMN nombre,
  DROP COLUMN descripcion,
  DROP COLUMN precio_publico,
  DROP COLUMN precio_dolar,
  DROP COLUMN lugar_embarque,
  DROP COLUMN lugar,
  DROP COLUMN ciudad,
  ADD COLUMN raw_data JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE chunks ALTER COLUMN raw_data DROP DEFAULT;

-- down
ALTER TABLE chunks
  DROP COLUMN raw_data,
  ADD COLUMN nombre TEXT,
  ADD COLUMN descripcion TEXT,
  ADD COLUMN precio_publico NUMERIC,
  ADD COLUMN precio_dolar NUMERIC,
  ADD COLUMN lugar_embarque TEXT,
  ADD COLUMN lugar TEXT,
  ADD COLUMN ciudad TEXT;
```

**Nota sobre datos existentes (limitación conocida y aceptada):** este entorno solo tiene datos de prueba subidos durante la validación de v1/v3/v4/v6/v7 (no hay catálogo de producción real cargado — confirmado por el estado actual del proyecto, todas las specs implementadas hasta ahora son de validación técnica). Al correr esta migración:
- Los chunks ya existentes **pierden** sus columnas `nombre`/`descripcion`/etc. (se dropean). Su columna `content` (ya generada por `buildContent` v1) **no se toca** y sigue siendo texto legible y buscable — no rompe embeddings ya generados.
- Su nueva columna `raw_data` queda en `{}` para esas filas viejas (el objeto original de v1 nunca se guardó crudo, no hay forma de reconstruirlo retroactivamente).
- Si Eder quiere que el catálogo de prueba actual tenga `raw_data` poblado correctamente, la forma más simple es volver a subir el mismo archivo JSON después de aplicar esta migración (crea un `document`/`chunks` nuevos; los viejos pueden borrarse manualmente si se desea, `ON DELETE CASCADE` ya limpia `job_status` asociado). Esto no es un criterio de aceptación de esta spec — se deja como acción operativa después del deploy, a decisión de Eder.

**Resuelto (confirmado por Eder, 2026-08-27):** no hay ningún catálogo real de producción cargado hoy en `chunks` — son datos de prueba. Se procede con la migración destructiva descrita arriba, sin backfill de `raw_data`.

### 4. Cambios en código relacionados (para referencia de `nestjs-rag-developer`, no vinculante en detalle de implementación)

- `dto/tour-item.dto.ts` se elimina.
- `DocumentsService.validateItems` deja de usar `class-validator`/`plainToInstance` con `TourItemDto`; implementa las reglas estructurales de la sección 1 a mano (o con un validador JSON Schema genérico tipo Ajv, a discreción del implementador, siempre que el contrato de error HTTP 400 se mantenga igual de específico).
- `DocumentUploadedPayload.items` cambia de `TourItemDto[]` a `Record<string, unknown>[]`.
- `ChunksService.buildContent(item: TourItemDto)` → `ChunksService.flattenToText(item: Record<string, unknown>)`.
- `ChunksService.createChunk` / `ChunksRepository.create` / `CreateChunkInput`: los campos `nombre`, `descripcion`, `precioPublico`, `precioDolar`, `lugarEmbarque`, `lugar`, `ciudad` se reemplazan por un único campo `rawData: Record<string, unknown>`.
- `entities/chunk.entity.ts`: las 7 `@Column` de tour se eliminan; se agrega `@Column({ name: 'raw_data', type: 'jsonb' }) rawData: Record<string, unknown>;`.
- `modules/chunks/listeners/document-uploaded.listener.ts`: sin cambios de lógica, solo de tipos (itera `Record<string, unknown>[]` en vez de `TourItemDto[]`).

## Contratos de API

El contrato de request/response de `POST /documents/upload` **no cambia de forma** (sigue siendo `multipart/form-data`, campo `file`, respuesta 202 con `documentId`/`totalItems`/`status`) — lo que cambia es qué JSON es válido dentro del archivo.

**Request — ejemplo con schema de tour (sigue funcionando, backward compatible):**
```
file: tours.json
```
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

**Request — ejemplo con schema completamente distinto (nuevo, antes se rechazaba):**
```
file: productos.json
```
```json
[
  {
    "sku": "ABC-123",
    "titulo": "Silla ergonómica de oficina",
    "precio": 450000,
    "moneda": "COP",
    "specs": { "color": "negro", "material": "malla" },
    "tags": ["oficina", "ergonomico", "premium"]
  }
]
```

**Response — éxito (HTTP 202), igual en ambos casos:**
```json
{
  "documentId": "b3f1...-uuid",
  "totalItems": 1,
  "status": "processing"
}
```

**Response — error de validación estructural (HTTP 400), nuevos casos:**
```json
{
  "statusCode": 400,
  "message": "El item en la posición 2 no es un objeto JSON válido",
  "errors": [ { "index": 2, "field": "root", "constraint": "El elemento debe ser un objeto, no array/string/number/null" } ]
}
```
```json
{
  "statusCode": 400,
  "message": "El item en la posición 0 no contiene ningún dato serializable a texto",
  "errors": [ { "index": 0, "field": "root", "constraint": "El objeto está vacío o todos sus valores son nulos/vacíos" } ]
}
```
```json
{
  "statusCode": 400,
  "message": "El archivo debe contener al menos un elemento"
}
```

## Esquema de datos

Nueva migración (nombre sugerido: `<timestamp>-GenericChunkSchema.ts`) sobre la tabla `chunks` ya existente:

```sql
ALTER TABLE chunks
  DROP COLUMN nombre,
  DROP COLUMN descripcion,
  DROP COLUMN precio_publico,
  DROP COLUMN precio_dolar,
  DROP COLUMN lugar_embarque,
  DROP COLUMN lugar,
  DROP COLUMN ciudad,
  ADD COLUMN raw_data JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE chunks ALTER COLUMN raw_data DROP DEFAULT;
```

Esquema resultante de `chunks` tras esta spec:

```sql
CREATE TABLE chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  raw_data JSONB NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Las tablas `documents` y `job_status` no cambian.

Nuevas variables de entorno (`rag/.env.example`):
```bash
# --- Validación de /documents/upload (spec 02 v2) ---
MAX_UPLOAD_ITEMS=2000
MAX_ITEM_DEPTH=6
MAX_ITEM_SIZE_BYTES=100000
```

## Impacto en specs downstream (verificado leyendo el código actual)

- **Spec 03 (embedding job)**: sin impacto. `EmbedChunkListener` solo lee `chunk.content` para llamar a `OllamaProvider.embed()` y escribe `chunks.embedding`/`status`/`error_message` — ninguno de esos campos cambia de tipo ni de nombre. Los 6 criterios de aceptación de la spec 03 siguen aplicando sin modificación.
- **Spec 04 (query endpoint)**: sin impacto. Confirmado en `chunks.repository.ts::findNearest` (`SELECT id, content, (embedding <=> $1::vector) AS distance FROM chunks WHERE status='done' ...`) y en `query.service.ts::askChatModel` (`candidates.map(c => c.content).join('\n')`) — ninguno de los dos usa `nombre`/`descripcion`/etc. Los 9 criterios de aceptación de la spec 04 siguen aplicando sin modificación.
- **Spec 06 (frontend)**: sin impacto. `UploadView` solo envía el archivo y muestra `documentId`/`totalItems` de la respuesta; `AskView` solo envía `question` y muestra `answer`/`matched`. Ninguno de los 7 criterios de aceptación de la spec 06 depende del schema de los items subidos.
- **Spec 00 (arquitectura general)**: la sección "Esquema de 'tour' subido" queda marcada como histórica/superada por esta spec — se agrega una nota ahí mismo señalando el cambio (ver commit de esta spec), sin borrar la tabla original para referencia.

## Delta respecto a v1 — qué criterios siguen vigentes y cuáles cambian

De los 9 criterios de aceptación de `02-upload-y-chunking-job.md` (v1):

| # | Criterio v1 | Estado en v2 |
|---|---|---|
| 1 | Migración aplica, `chunks` tiene `embedding vector(1536)` + índice HNSW | **Vigente**, pero `\d chunks` ahora debe reflejar el esquema nuevo (sin columnas de tour, con `raw_data jsonb`) — ver criterio v2 #1 |
| 2 | Upload de 3 tours válidos → 202 con `documentId`/`totalItems=3` | **Vigente sin cambios** (usar un JSON de tours sigue siendo válido) |
| 3 | 3 filas en `chunks` con `status='pending'`, `embedding IS NULL`, `content` no vacío | **Vigente sin cambios** |
| 4 | 1 fila en `job_status` tipo `chunking`, `status='done'` | **Vigente sin cambios** |
| 5 | `content` contiene nombre, descripción y precio del tour en texto legible | **Cambia**: ya no se verifica contra esos campos específicos, sino contra el resultado genérico de `flattenToText` — ver criterio v2 #5 |
| 6 | Archivo no JSON válido → 400, no crea filas | **Vigente sin cambios** |
| 7 | Item sin campo `nombre` → 400 identificando índice/campo | **Cambia**: ya no existe un campo `nombre` obligatorio; se reemplaza por los criterios v2 #7-#11 (item no es objeto, profundidad excedida, tamaño excedido, contenido vacío, array vacío) |
| 8 | Sin campo `file` → 400 | **Vigente sin cambios** |
| 9 | `documents.status='processing'` inmediatamente tras el 202 | **Vigente sin cambios** |

## Criterios de aceptación

1. Tras aplicar la nueva migración, `\d chunks` en psql muestra las columnas `id, document_id, raw_data (jsonb, not null), content (text, not null), embedding (vector(1536)), status, error_message, created_at, updated_at` — **sin** `nombre`, `descripcion`, `precio_publico`, `precio_dolar`, `lugar_embarque`, `lugar`, `ciudad`.
2. `POST /documents/upload` con un JSON de 3 tours (mismo formato que v1) devuelve HTTP 202 igual que antes, con `documentId` y `totalItems=3`.
3. `POST /documents/upload` con un JSON de esquema completamente distinto — ej. `[{"sku":"ABC-123","titulo":"Silla ergonómica","precio":450000,"specs":{"color":"negro"}}, {"sku":"XYZ-9","titulo":"Escritorio","precio":900000,"specs":{"color":"blanco"}}]` — devuelve HTTP 202 con `totalItems=2`.
4. Para el documento del criterio 3, la tabla `chunks` tiene 2 filas donde `raw_data` (comparado como JSON, no como string) es exactamente igual al objeto original correspondiente de la posición del array, y `content` contiene las líneas `sku: ABC-123.`, `titulo: Silla ergonómica.`, `precio: 450000.`, `specs.color: negro.` (verificación por inspección directa de una fila).
5. Tras el paso normal de embedding (spec 03, sin cambios), los chunks del criterio 3 terminan con `status='done'`, `embedding IS NOT NULL`, `vector_dims(embedding)=1536`.
6. `POST /query` con `{"question": "¿cuánto cuesta la silla ergonómica ABC-123?"}` sobre el catálogo del criterio 3 devuelve HTTP 200, `matched: true`, y `answer` contiene `450000` (o su formato con separador de miles).
7. `POST /documents/upload` con un array que contiene un elemento no-objeto (ej. `["a", {"x":1}]`) devuelve HTTP 400 identificando el índice 0, y no crea ninguna fila en `documents` ni `chunks`.
8. `POST /documents/upload` con un array vacío (`[]`) devuelve HTTP 400 con mensaje indicando que el archivo debe tener al menos un elemento.
9. `POST /documents/upload` con un elemento cuyo objeto está vacío (`{}`) o cuyos valores son todos `null` devuelve HTTP 400 identificando el índice, sin crear filas.
10. `POST /documents/upload` con un elemento anidado más allá de `MAX_ITEM_DEPTH` (ej. 7+ niveles de objetos anidados con `MAX_ITEM_DEPTH=6`) devuelve HTTP 400 identificando el índice.
11. `POST /documents/upload` con un elemento cuyo `JSON.stringify` excede `MAX_ITEM_SIZE_BYTES` devuelve HTTP 400 identificando el índice.
12. `POST /documents/upload` con un array de más de `MAX_UPLOAD_ITEMS` elementos devuelve HTTP 400.
13. Se re-ejecutan y pasan sin modificación los criterios 1, 3, 4, 6 (embedding), 5-9 de spec 04 (query, no dependen de schema) y 1-7 de spec 06 (frontend) — regresión de las specs downstream ya implementadas, confirmando que el cambio de schema no las rompió.
14. `rag/.env.example` incluye `MAX_UPLOAD_ITEMS`, `MAX_ITEM_DEPTH`, `MAX_ITEM_SIZE_BYTES` con los defaults documentados en "Esquema de datos".

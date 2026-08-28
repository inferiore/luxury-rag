# Validación — 02-upload-y-chunking-job-v2

Fecha: 2026-08-27
Veredicto general: PASS (14/14 criterios)

Nota metodológica: esta validación se hizo con especial rigor porque la implementación
se ejecutó sin clasificador de seguridad disponible. No se confió en el reporte del
implementador — se releyó línea por línea `upload-item-validator.ts`, `chunks.service.ts`,
`chunk.entity.ts` y la migración `GenericChunkSchema1787867971123.ts`, se rebuildeó la
imagen Docker, se corrieron build/lint/tests localmente, y se ejecutaron pruebas HTTP/SQL
reales contra el sistema vivo, incluyendo un E2E real de frontend con Playwright (Chromium)
contra el backend en Docker.

## Revisión de código (previa a las pruebas de comportamiento)

- `find src -iname "tour-item*"` → sin resultados. `grep -rn "TourItemDto" src dist test` →
  cero referencias de código (solo un comentario histórico en `upload-item-validator.ts`
  explicando qué reemplaza). `dto/tour-item.dto.ts` confirmado eliminado y no referenciado.
- `src/modules/documents/validation/upload-item-validator.ts`: `isPlainObject`,
  `calculateDepth`, `serializedSizeBytes` revisados línea por línea — la lógica de
  profundidad (`calculateDepth`) fue verificada empíricamente con objetos de profundidad
  exacta 6 y 7 (ver criterio 10): el límite se aplica correctamente en el borde.
- `src/modules/chunks/chunks.service.ts`: `flattenToText`/`flattenValue` revisados línea
  por línea — omite `null`/`undefined`/`''`, primitivos como `"clave: valor."`, objetos
  recursando con `.`, arrays de primitivos con join por coma, arrays de objetos con
  `[i]`. Confirmado con 4 schemas JSON distintos (ver criterios 3-6 y sección adicional).
- `src/modules/chunks/entities/chunk.entity.ts`: sin las 7 columnas de tour; una sola
  `@Column({ name: 'raw_data', type: 'jsonb' }) rawData`.
- `src/database/migrations/1787867971123-GenericChunkSchema.ts`: `up`/`down` coinciden
  exactamente con el SQL documentado en la spec (DROP de las 7 columnas + ADD raw_data
  con DEFAULT '{}' seguido de DROP DEFAULT; down revierte simétricamente).
- `src/modules/documents/documents.service.ts::validateItems`: orden de validación
  (objeto plano → profundidad → tamaño → contenido no vacío) y rechazo total del batch
  con `errors[]` e índice del primer elemento inválido, tal como exige la spec.

## Criterio 1: `\d chunks` refleja el esquema nuevo tras la migración

**Resultado:** PASS
**Comando:** `docker exec rag-postgres psql -U rag_user -d rag_db -c "\d chunks"`
**Evidencia:**
```
    Column     |           Type           | Collation | Nullable |           Default
---------------+--------------------------+-----------+----------+------------------------------
 id            | uuid                     |           | not null | gen_random_uuid()
 document_id   | uuid                     |           | not null |
 content       | text                     |           | not null |
 embedding     | vector(1536)             |           |          |
 status        | character varying(20)    |           | not null | 'pending'::character varying
 error_message | text                     |           |          |
 created_at    | timestamp with time zone |           | not null | now()
 updated_at    | timestamp with time zone |           | not null | now()
 raw_data      | jsonb                    |           | not null |
Indexes:
    "chunks_pkey" PRIMARY KEY, btree (id)
    "chunks_document_id_idx" btree (document_id)
    "chunks_embedding_hnsw_idx" hnsw (embedding vector_cosine_ops)
    "chunks_status_idx" btree (status)
```
Sin `nombre`, `descripcion`, `precio_publico`, `precio_dolar`, `lugar_embarque`, `lugar`,
`ciudad`. `raw_data jsonb not null` presente. Índice HNSW sobre `embedding` intacto.
`SELECT * FROM migrations` confirma `GenericChunkSchema1787867971123` aplicada
(id 2, tras `InitialSchema1787860686682`).

## Criterio 2: upload de 3 tours (schema viejo) → 202, `totalItems=3`

**Resultado:** PASS
**Comando:** `curl -s -X POST http://localhost:3000/documents/upload -F "file=@tours.json" -w "\nHTTP_STATUS:%{http_code}\n"`
**Evidencia:**
```
{"documentId":"8421e564-e1ea-41c6-87c5-f47eae3e377e","totalItems":3,"status":"processing"}
HTTP_STATUS:202
```

## Criterio 3: upload de schema completamente distinto (productos e-commerce) → 202, `totalItems=2`

**Resultado:** PASS
**Comando:** `curl -s -X POST http://localhost:3000/documents/upload -F "file=@productos.json" -w "\nHTTP_STATUS:%{http_code}\n"`
**Evidencia:**
```
{"documentId":"7ed69a09-0f97-43f5-a683-273d72998981","totalItems":2,"status":"processing"}
HTTP_STATUS:202
```
Payload usado (idéntico al de la spec):
`[{"sku":"ABC-123","titulo":"Silla ergonómica","precio":450000,"specs":{"color":"negro"}}, {"sku":"XYZ-9","titulo":"Escritorio","precio":900000,"specs":{"color":"blanco"}}]`

## Criterio 4: `raw_data` exacto + `content` con las líneas esperadas

**Resultado:** PASS
**Comando:** `docker exec rag-postgres psql -U rag_user -d rag_db -c "SELECT id, raw_data, content, status FROM chunks WHERE document_id='7ed69a09-...' ORDER BY created_at;"`
**Evidencia:**
```
raw_data: {"sku": "ABC-123", "specs": {"color": "negro"}, "precio": 450000, "titulo": "Silla ergonómica"}
content:  sku: ABC-123. titulo: Silla ergonómica. precio: 450000. specs.color: negro.

raw_data: {"sku": "XYZ-9", "specs": {"color": "blanco"}, "precio": 900000, "titulo": "Escritorio"}
content:  sku: XYZ-9. titulo: Escritorio. precio: 900000. specs.color: blanco.
```
`raw_data` es JSON exactamente igual al item original (comparado por campo, no como
string — los campos coinciden 1:1). `content` contiene las 4 líneas exigidas por la
spec, en el orden correcto.

## Criterio 5: chunks del criterio 3 terminan `done`, embedding no nulo, 1536 dims

**Resultado:** PASS
**Comando:** `docker exec rag-postgres psql -U rag_user -d rag_db -c "SELECT id, status, embedding IS NOT NULL, vector_dims(embedding) FROM chunks WHERE document_id='7ed69a09-...';"`
**Evidencia:**
```
status | has_embedding | vector_dims
done   | t             | 1536
done   | t             | 1536
```

## Criterio 6: `POST /query` sobre el catálogo del criterio 3 → matched:true, precio correcto

**Resultado:** PASS
**Comando:** `curl -s -X POST http://localhost:3000/query -H "Content-Type: application/json" -d '{"question": "¿cuánto cuesta la silla ergonómica ABC-123?"}'`
**Evidencia:**
```
{"answer":"La silla ergonómica ABC-123 cuesta 450000.","matched":true}
HTTP_STATUS:200
```

### Verificación adicional (más allá de lo pedido por el implementador): 2 schemas propios, independientes de los ejemplos de la spec

Para confirmar de forma independiente que el sistema es realmente schema-agnostic (no
solo con los 2 ejemplos que trae la spec/el reporte del implementador), se subieron y
consultaron dos catálogos con formas completamente distintas entre sí y respecto a
tours/productos:

**Schema A — menú de restaurante** (con array de primitivos, objeto anidado y array de
objetos, ejercitando las 3 ramas no triviales de `flattenToText`):
```json
[{"plato":"Bandeja Paisa","ingredientes":["frijoles","arroz","chicharrón","huevo"],
  "precio_cop":35000,"restaurante":{"nombre":"El Rancherito","ciudad":"Medellín"},
  "acompañamientos":[{"nombre":"Patacón","extra":true},{"nombre":"Arepa","extra":false}]},
 {"plato":"Ajiaco Santafereño", ...}]
```
Upload → `202 {"totalItems":2}`. `content` generado:
```
plato: Bandeja Paisa. ingredientes: frijoles, arroz, chicharrón, huevo. precio_cop: 35000.
restaurante.nombre: El Rancherito. restaurante.ciudad: Medellín.
acompañamientos[0].nombre: Patacón. acompañamientos[0].extra: true.
acompañamientos[1].nombre: Arepa. acompañamientos[1].extra: false.
```
`POST /query {"question": "¿cuánto cuesta el ajiaco santafereño?"}` → `{"answer":"28000","matched":true}`.

**Schema B — inmuebles en arriendo** (3 niveles de anidamiento, `ubicacion.coordenadas.lat/lng`):
```json
[{"codigo":"INM-001","tipo":"Apartamento","precio_arriendo_mensual":3500000,
  "ubicacion":{"barrio":"El Poblado","ciudad":"Medellín","coordenadas":{"lat":6.209,"lng":-75.567}},
  "amenidades":["piscina","gimnasio","portería 24h"]}]
```
Upload → `202 {"totalItems":1}`. `content` generado:
```
codigo: INM-001. tipo: Apartamento. precio_arriendo_mensual: 3500000.
ubicacion.barrio: El Poblado. ubicacion.ciudad: Medellín.
ubicacion.coordenadas.lat: 6.209. ubicacion.coordenadas.lng: -75.567.
amenidades: piscina, gimnasio, portería 24h.
```
`POST /query {"question": "¿cuánto cuesta el arriendo mensual del inmueble INM-001?"}`
→ `{"answer":"El arriendo mensual del inmueble INM-001 cuesta 3.500.000 pesos.","matched":true}`.

Con esto quedan probados 4 schemas totalmente distintos (tours, productos e-commerce,
menú de restaurante, inmuebles) generando embeddings correctos y respuestas de `/query`
correctas — evidencia sólida de que el sistema es genuinamente schema-agnostic.

## Criterio 7: elemento no-objeto en el array → 400, índice 0, sin filas huérfanas

**Resultado:** PASS
**Comando:** `curl -s -X POST http://localhost:3000/documents/upload -F 'file=@reject-nonobject.json'` con `["a", {"x":1}]`
**Evidencia:**
```
{"statusCode":400,"message":"El item en la posición 0 no es un objeto JSON válido","errors":[{"index":0,"field":"root","constraint":"El elemento debe ser un objeto, no array/string/number/null"}]}
HTTP_STATUS:400
```
Conteo de `documents`/`chunks` antes y después idéntico (19/38) — sin filas huérfanas.

## Criterio 8: array vacío → 400

**Resultado:** PASS
**Comando:** `curl -s -X POST http://localhost:3000/documents/upload -F 'file=@reject-emptyarray.json'` con `[]`
**Evidencia:**
```
{"message":"El archivo debe contener al menos un elemento","error":"Bad Request","statusCode":400}
```

## Criterio 9: objeto vacío o con todos los valores nulos → 400, índice identificado

**Resultado:** PASS
**Comando:** `curl -s -X POST .../upload -F 'file=@reject-emptyobj.json'` (`[{}]`) y con `[{"a":null,"b":null,"c":""}]`
**Evidencia:**
```
{"statusCode":400,"message":"El item en la posición 0 no contiene ningún dato serializable a texto","errors":[{"index":0,"field":"root","constraint":"El objeto está vacío o todos sus valores son nulos/vacíos"}]}
```
(idéntico para ambas variantes)

## Criterio 10: profundidad > `MAX_ITEM_DEPTH` (6) → 400, índice identificado

**Resultado:** PASS
**Comando:** objetos generados con Python, profundidad exacta 6 y 7 niveles
**Evidencia:**
```
Depth=6 (5 niveles de anidamiento + hoja) → 202 {"documentId":"0115a2c9-...","totalItems":1}
Depth=7 → 400 {"message":"El item en la posición 0 excede la profundidad máxima permitida de 6 niveles", ...}
```
Confirmado el borde exacto: 6 se acepta, 7 se rechaza — coincide con el default
`MAX_ITEM_DEPTH=6` documentado.

## Criterio 11: `JSON.stringify` > `MAX_ITEM_SIZE_BYTES` (100000) → 400, índice identificado

**Resultado:** PASS
**Comando:** item con un string de 100050 bytes (archivo total 100066 bytes)
**Evidencia:**
```
{"statusCode":400,"message":"El item en la posición 0 excede el tamaño máximo permitido de 100000 bytes","errors":[{"index":0,"field":"root","constraint":"El elemento excede el tamaño máximo permitido de 100000 bytes"}]}
```

## Criterio 12: array de más de `MAX_UPLOAD_ITEMS` (2000) elementos → 400

**Resultado:** PASS
**Comando:** array de 2001 elementos (`[{"idx":i,"valor":"test"} for i in range(2001)]`)
**Evidencia:**
```
{"statusCode":400,"message":"El archivo contiene 2001 elementos, el máximo permitido es 2000"}
```

**Verificación de no-filas-huérfanas para criterios 8-12 en conjunto:**
`documents`/`chunks` antes de la ronda de rechazos: 19/38. Después de los 7 intentos de
rechazo (empty array, non-object, empty object, all-null, depth boundary 6 válido,
depth 7 inválido, size inválido, 2001 items inválido): 20/39 — exactamente +1
documento/+1 chunk, correspondiente únicamente al único upload válido de la ronda
(profundidad exacta 6, que debía aceptarse). Cero filas huérfanas de los rechazos.

## Criterio 13: regresión de specs 03, 04 y 06

**Resultado:** PASS

**Spec 03 (criterios 1, 3, 4)** — sobre el documento de tours subido en el criterio 2:
```sql
-- chunks: 3 filas status=done, embedding no nulo, vector_dims=1536
-- job_status: 3 filas job_type=embedding, status=done, chunk_id distinto cada una
-- documents.status = 'done'
```
Confirmado por consulta SQL directa (ver comandos ejecutados), sin intervención manual —
el pipeline de embedding de spec 03 procesó los chunks igual que antes del cambio de
schema.

**Spec 04 (criterios 5-9)** — probado con `/query` real:
- Crit. 5 (usa `DEFAULT_TOP_K` si se omite `topK`): confirmado por comportamiento — todas
  las preguntas sin `topK` devuelven respuesta de un solo tour/chunk, consistente con
  `DEFAULT_TOP_K=1` en `.env`.
- Crit. 6 (`topK=3` trae 3 candidatos): `curl -d '{"question":"tours en Medellín","topK":3}'`
  → respuesta sintetiza los 3 tours cargados (Café, Comuna 13, Guatapé), confirmando que
  se recuperaron y usaron los 3 candidatos.
- Crit. 7 (`question` vacío/ausente → 400):
  ```
  {"question":""}  → {"message":["question no puede estar vacío"],"statusCode":400}
  {}               → {"message":["question no puede estar vacío","question must be a string"],"statusCode":400}
  ```
- Crit. 8 (umbral gatea la respuesta): se puso `SIMILARITY_THRESHOLD=0` en `.env`, se
  reinició `rag-app` (`docker compose up -d app`), y una pregunta que antes daba
  `matched:true` (`"¿cuánto cuesta la silla ergonómica ABC-123?"`) pasó a devolver
  `{"answer":"datos no encontrados","matched":false}`. Se restauró
  `SIMILARITY_THRESHOLD=0.4` y se reinició de nuevo, confirmando que la pregunta volvió a
  dar `{"answer":"450000","matched":true}` — el umbral gatea realmente la respuesta.
- Crit. 9 (Langfuse no configurado no rompe `/query`): `LANGFUSE_PUBLIC_KEY`/`SECRET_KEY`
  están vacíos en `.env` durante toda la sesión, y las ~10 llamadas reales a `/query`
  ejecutadas en esta validación respondieron siempre HTTP 200, nunca 500.

**Spec 06 (frontend, criterios 1-7)** — E2E real con Playwright (Chromium) contra
`npm run dev` (Vite, puerto 5173) y el backend en Docker (puerto 3000):
- Crit. 1: `http://localhost:5173/` sirve la página con los dos formularios
  ("Subir catálogo de tours", "Preguntar sobre el catálogo").
- Crit. 2: se subió `tours.json` desde el input de archivo real de la UI; se capturó en
  la red del navegador `POST http://localhost:3000/documents/upload`; la UI mostró
  `documentId`/`totalItems=3`/`status=processing` reales devueltos por el backend.
- Crit. 3: se preguntó "¿Cuánto cuesta el tour a Guatapé?" desde la UI real; la UI
  mostró la respuesta real del backend ("El tour 'Guatapé + Peñol' cuesta **180.000
  COP / 45 USD**...", panel `.status-success`) — no un placeholder.
- Crit. 4: se preguntó "¿Cuál es la capital de Francia?"; la UI mostró el panel
  `.status-info` con "No encontramos información sobre eso en el catálogo." — visualmente
  distinto del éxito y del error (clases CSS distintas confirmadas en el código:
  `status-success` / `status-info` / `status-error`).
- Crit. 5: se detuvo `rag-app` (`docker stop rag-app`) y se repitió una pregunta desde la
  UI; apareció el panel `.status-error` con "No se pudo conectar con el servidor.
  Verifica que el backend esté corriendo." — claramente distinto de los otros dos
  estados. Se reinició `rag-app` inmediatamente después.
- Crit. 6 (revisión de código): `UploadView.tsx` y `AskView.tsx` revisados — no hay
  ningún cálculo de precios/descuentos ni transformación de datos de negocio; solo
  llaman a `uploadTours`/`askQuestion` y renderizan la respuesta tal cual.
- Crit. 7: `frontend/.env.example` define `VITE_API_BASE_URL=http://localhost:3000`;
  `src/api/config.ts` lo lee vía `import.meta.env.VITE_API_BASE_URL` sin ningún host
  hardcodeado alternativo en el código.

## Criterio 14: `.env.example` incluye las 3 variables con los defaults documentados

**Resultado:** PASS
**Comando:** `grep -n -B2 -A1 "MAX_UPLOAD_ITEMS\|MAX_ITEM_DEPTH\|MAX_ITEM_SIZE_BYTES" rag/.env.example`
**Evidencia:**
```
# --- Validación de /documents/upload (spec 02 v2) ---
MAX_UPLOAD_ITEMS=2000
MAX_ITEM_DEPTH=6
MAX_ITEM_SIZE_BYTES=100000
```
También presentes en `src/config/configuration.ts` (con los mismos defaults vía
`parseInt(... ?? '2000'/'6'/'100000')`) y en `src/config/env.validation.ts`
(`Joi.number().default(2000|6|100000)`).

## Build, lint y tests — corridos por el validador, no solo reportados

**Build:** `npm run build` → `nest build` sin errores.
**Lint:** `npm run lint` → `10 problems (0 errors, 10 warnings)` — los 10 warnings son
`@typescript-eslint/no-unsafe-argument` preexistentes en archivos `*.spec.ts` de otros
módulos (jobs, embeddings), no relacionados con esta spec.
**Tests:** `npm test` → `Test Suites: 10 passed, 10 total` / `Tests: 53 passed, 53 total`.

## Estado final del sistema (limpieza)

- `SIMILARITY_THRESHOLD` restaurado a `0.4` en `.env` (confirmado con `diff` contra el
  backup tomado antes de la prueba del criterio 8 de la spec 04 — sin diferencias).
- Servidor Vite de desarrollo (`npm run dev`, puerto 5173) detenido tras el E2E.
- `rag-app` reiniciado y saludable tras la prueba de caída de backend (criterio 5 de
  spec 06) — `curl http://localhost:3000/health` → `200`.
- `rag-app` y `rag-postgres` quedan corriendo (estado normal del entorno de desarrollo,
  igual que al iniciar esta validación).
- Se crearon documentos/chunks de prueba adicionales durante esta validación (subidas
  válidas de tours/productos/recetas/inmuebles + 1 upload límite de profundidad) — el
  entorno pasó de 15/30 filas en `documents`/`chunks` a 22/45. Es un entorno exclusivo
  de pruebas (confirmado por la spec misma, sección "Nota sobre datos existentes"), no
  hay catálogo de producción que se haya podido corromper. No se borró nada.
- Todos los intentos de subida inválida (7 rechazos probados) confirmaron cero filas
  huérfanas — el conteo de filas solo avanzó por uploads válidos.

## Conclusión

Los 14 criterios de aceptación de `02-upload-y-chunking-job-v2.md` pasan con evidencia
real y reproducible: código fuente revisado línea por línea, migración verificada contra
`\d chunks`, 4 schemas JSON completamente distintos probados de punta a punta (upload →
chunk → embedding → query), los 6 casos de rechazo estructural (más variantes de borde)
verificados sin filas huérfanas, regresión real de specs 03/04/06 (incluyendo un E2E de
frontend con navegador real), y build/lint/tests corridos independientemente por el
validador. Se sugiere que `rag-spec-planner` actualice el `Estado` de esta spec a
`Implementado`.

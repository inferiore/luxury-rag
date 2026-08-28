# 00 — Arquitectura general del sistema RAG

## Estado
Referencia (documento de contrato ya validado con Eder — no es una spec pendiente de aprobación, no tiene criterios de aceptación testeables propios). Los agentes de implementación deben leerlo antes de tocar cualquier spec numerada.

## Contexto y objetivo

Luxury Horizon quiere un sistema RAG independiente del sitio web principal, en `rag/`, que responda preguntas sobre su catálogo de tours usando búsqueda por similitud coseno sobre embeddings generados localmente con Ollama. El flujo de trabajo del proyecto es *spec-driven*: `rag-spec-planner` redacta specs incrementales en `rag/specs/`, Eder las aprueba una por una, y los agentes de implementación (`nestjs-rag-developer`, `rag-deployment-engineer`, `react-rag-frontend`) solo actúan sobre specs con `Estado: Aprobado`. `rag-acceptance-validator` verifica los criterios de aceptación contra el sistema real antes de marcar una spec como `Implementado`.

## Decisiones confirmadas

- **Backend**: NestJS, Service Layered Architecture (Controller → Service → Repository/Provider). Sin autenticación por ahora.
- **Base de datos**: Postgres + extensión `pgvector`.
- **Dimensión del vector**: configurable vía env var `VECTOR_DIM`, **default 1536**. `qwen3-embedding` produce nativamente vectores de 4096 dimensiones (`curl http://localhost:11434/api/tags` → `embedding_length: 4096`), pero soporta truncamiento tipo Matryoshka: el endpoint `/api/embed` de Ollama acepta un parámetro `dimensions` que trunca el vector de salida al tamaño pedido, verificado empíricamente (`curl http://localhost:11434/api/embed -d '{"model":"qwen3-embedding","input":"texto de prueba","dimensions":1536}'` → devuelve un vector de 1536 elementos). Por eso `VECTOR_DIM=1536` es viable como default real, no un valor arbitrario. **Limitación conocida**: pgvector fija la dimensión de la columna al crearla; cambiar `VECTOR_DIM` después de tener datos (a otro valor, o a otro modelo de embedding) requiere una migración que altere la columna y **re-embeba todos los chunks existentes** pidiendo esa nueva dimensión en cada llamada a `/api/embed`.
- **Embeddings**: HTTP a Ollama `POST /api/embed` (el endpoint `/api/embeddings` es el legacy/deprecado y **no soporta** truncamiento de dimensión — no usarlo). Body: `{ "model": "<EMBEDDING_MODEL>", "input": "<texto>", "dimensions": <VECTOR_DIM> }`. La respuesta trae `embeddings: number[][]` (array de vectores, plural, incluso para un solo input) — tomar `embeddings[0]`. Modelo configurable vía env `EMBEDDING_MODEL` (default `qwen3-embedding`).
- **Chat/respuesta**: HTTP a Ollama `POST /api/chat`, `stream: false`, modelo configurable vía env `CHAT_MODEL` (default `qwen3:8b`). Este modelo tiene capacidad de "thinking" y puede emitir bloques `<think>...</think>` en su salida — deben stripearse siempre antes de devolver la respuesta al cliente (`common/utils/strip-think-tags.ts`).
- **Jobs**: sin Redis ni BullMQ. `@nestjs/event-emitter` (EventEmitter2) en memoria + una tabla `job_status` en Postgres que persiste el estado (`pending`/`processing`/`done`/`failed`) de cada job, para poder consultar progreso aunque la cola en sí viva solo en memoria del proceso (se pierde si el proceso reinicia — aceptado como trade-off por simplicidad de infra).
- **Monitoreo/tracing**: Langfuse (open source). Por defecto se usa **Langfuse Cloud (free tier)** — evita levantar infraestructura adicional (el self-host completo de Langfuse v3 requiere Postgres+ClickHouse+Redis+almacenamiento S3-compatible, lo cual contradice la decisión de mantener la infra liviana sin Redis). Si en el futuro se requiere self-host por control de datos, debe documentarse como cambio explícito en una spec propia. Se traza: el embedding de la pregunta, la búsqueda de similitud (chunk recuperado + score) y la llamada al chat model (prompt, respuesta, tokens/latencia).
- **Endpoints públicos** (los únicos dos que el frontend React consume):
  - `POST /documents/upload` — sube un archivo JSON con un array de objetos; dispara el job de chunking (1 objeto del array = 1 chunk, sin necesidad de partir texto largo) y, por cada chunk creado, el job de embedding. **Actualizado (Eder, 2026-08-27):** el schema del objeto ya no está limitado a la forma "tour" descrita más abajo — ver `02-upload-y-chunking-job-v2.md`, que acepta cualquier objeto JSON válido.
  - `POST /query` — recibe `{ question: string, topK?: number }` (`topK` default = 1, parametrizable vía env `DEFAULT_TOP_K` y override por request). Puede haber endpoints internos adicionales (health, status de un documento) que el frontend no necesariamente consume.

## Esquema de "tour" subido (igual a la hoja "Servicios" del negocio) — HISTÓRICO, superado por `02-upload-y-chunking-job-v2.md`

**Nota (Eder, 2026-08-27): esta sección queda como referencia histórica del schema que motivó el diseño original — ya NO es una restricción vigente.** `POST /documents/upload` acepta hoy cualquier array de objetos JSON de forma arbitraria (ver `02-upload-y-chunking-job-v2.md`, que reemplaza la validación por `TourItemDto`, la construcción de `content` y las columnas fijas de `chunks` descritas originalmente aquí). Se conserva la tabla de abajo sin editar porque sigue siendo un ejemplo válido de un schema soportado (uno más entre cualquier otro), no porque siga siendo obligatorio.

Cada objeto del array JSON subido correspondía a estas columnas (ver `CLAUDE.md` raíz, hoja "Servicios" del spreadsheet "Base de datos"):

| Campo JSON | Columna origen |
|---|---|
| `nombre` | Club de playa |
| `descripcion` | Descripción |
| `precio_publico` | Precio al público |
| `precio_dolar` | Precio Dollar |
| `lugar_embarque` | Lugar de embarque |
| `lugar` | Lugar |
| `ciudad` | (contexto adicional, no viene de "Servicios" pero se incluye para filtrar por destino) |

## Módulos NestJS (`rag/src/`)

```
src/
  main.ts
  app.module.ts
  config/                         # @nestjs/config + validación de env
  common/
    utils/strip-think-tags.ts
  database/
    typeorm.config.ts
    migrations/                   # incluye CREATE EXTENSION vector + tablas
  modules/
    documents/                    # POST /documents/upload
      documents.controller.ts
      documents.service.ts
      documents.repository.ts
      dto/upload-tours.dto.ts
      dto/tour-item.dto.ts
      entities/document.entity.ts
    chunks/
      chunks.service.ts           # crea 1 chunk por objeto, emite 'chunk.created'
      chunks.repository.ts
      entities/chunk.entity.ts
      listeners/chunk-created.listener.ts
    embeddings/
      embeddings.service.ts       # usa OllamaProvider.embed
      listeners/embed-chunk.listener.ts
    jobs/
      jobs.service.ts             # CRUD sobre job_status
      entities/job.entity.ts
    query/
      query.controller.ts         # POST /query
      query.service.ts
      dto/query-request.dto.ts
      dto/query-response.dto.ts
    ollama/
      ollama.provider.ts          # embed(text), chat(messages)
    langfuse/
      langfuse.service.ts
  health/
    health.controller.ts          # GET /health
```

## Esquema de tablas Postgres

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_filename TEXT NOT NULL,
  total_items INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|processing|done|failed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NOTA (Eder, 2026-08-27): esquema HISTÓRICO de `chunks` (spec 02 v1).
-- Superado por `02-upload-y-chunking-job-v2.md`, que reemplaza las 7
-- columnas fijas de tour por una sola columna `raw_data JSONB NOT NULL`.
-- Ver ese documento para el esquema vigente.
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
  content TEXT NOT NULL,           -- representación textual concatenada usada para el embedding
  embedding VECTOR(1536),          -- dimensión = VECTOR_DIM, fijada en la migración
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|processing|done|failed (embedding)
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
  job_type VARCHAR(20) NOT NULL,   -- 'chunking' | 'embedding'
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Índice HNSW en vez de IVFFlat**: HNSW no requiere una fase de "entrenamiento" (`lists`) que degrada resultados hasta acumular suficientes filas — encaja mejor con un catálogo de tours de cientos/pocos miles de registros. IVFFlat solo tendría sentido si el catálogo creciera a decenas de miles de chunks.

## Manejo de "sin coincidencia" en `/query`

Enfoque **híbrido**, a detallar en la spec `04-query-endpoint.md`:

1. El backend calcula la distancia coseno del mejor chunk (operador `<=>` de pgvector; 0 = idéntico, mayor = más lejano) y la compara contra `SIMILARITY_THRESHOLD` (env, valor inicial sugerido `0.4`, ajustable empíricamente).
2. Si la distancia **supera** el umbral: el backend responde directamente el texto exacto "datos no encontrados" **sin llamar al LLM** (ahorra latencia/costo, y se registra en Langfuse como evento de umbral no superado).
3. Si **no** supera el umbral: se llama igual a `qwen3:8b` con el system prompt exacto dado por Eder (abajo) como red de seguridad, para el caso en que el chunk recuperado esté cerca en similitud pero no contenga realmente la respuesta a la pregunta específica.

### System prompt exacto para el chat model

```
Eres mi asistente para la empresa luxury horizon que tiene un base de conocimiento amplio sobre los toures que ofrezco, debe ser calido y siempre reponder en español:
Reponde unicamente con la informacion que te suministramos como contexto.
Si no hay ningun concidencia no respondas nada, reponde con un funcion call : datos no encontrados
```

## Variables de entorno (`rag/.env.example`)

```bash
# --- Postgres ---
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=rag_user
POSTGRES_PASSWORD=changeme
POSTGRES_DB=rag_db

# --- Ollama ---
OLLAMA_BASE_URL=http://localhost:11434
EMBEDDING_MODEL=qwen3-embedding
CHAT_MODEL=qwen3:8b
VECTOR_DIM=1536

# --- Comportamiento de /query ---
DEFAULT_TOP_K=1
SIMILARITY_THRESHOLD=0.4

# --- Langfuse ---
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_HOST=https://cloud.langfuse.com

# --- App ---
PORT=3000
NODE_ENV=development
```

Nota: cuando la app corra dentro de Docker (spec 05), `OLLAMA_BASE_URL` debe apuntar a `http://host.docker.internal:11434` (Ollama corre en el host, no en un contenedor).

## Ambiente de pruebas aislado (`rag/docker-compose.test.yml`)

**Ya implementado y verificado** — no es una propuesta. Se agregó porque las validaciones de `rag-acceptance-validator` corrían antes contra la base de datos y el backend de desarrollo reales, contaminando los datos de dev y llegando a reiniciar `rag-app` de desarrollo dos veces durante una sola validación. Este stack es standalone: independiente de `docker-compose.yml` (producción) y `docker-compose.dev.yml` (desarrollo), pensado para levantarse, validarse y destruirse sin tocar el ambiente de dev.

- **`postgres-test`** → contenedor `rag-postgres-test`, puerto host `${TEST_POSTGRES_PORT:-5433}` → interno `5432`, volumen propio `rag_pgdata_test` (no comparte volumen con dev/prod), DB `rag_test_db` / user `rag_test_user` / password `changeme_test` (todos overrideables vía `.env`).
- **`app-test`** → contenedor `rag-app-test`, puerto host `${TEST_APP_PORT:-3001}` → interno `3000`, `POSTGRES_HOST=postgres-test` fijo (apunta siempre a la DB de test, no a la de dev). Usa el stage `runner` (producción) del `Dockerfile`; su `CMD` corre las migraciones (`typeorm migration:run`) antes de arrancar, así cada `up` valida también el camino real de deploy desde una base vacía.
- **Ollama no se aísla**: dev y test comparten el mismo Ollama del host vía `http://host.docker.internal:11434` — duplicarlo sería costoso e innecesario, ya que los pesos del modelo son idénticos.
- Variables opcionales documentadas en `rag/.env.example`: `TEST_POSTGRES_PORT`, `TEST_APP_PORT`, `TEST_POSTGRES_USER`, `TEST_POSTGRES_PASSWORD`, `TEST_POSTGRES_DB`. El resto de variables de la app (modelos, `VECTOR_DIM`, umbrales, CORS, límites de upload) se reutilizan de las secciones de arriba.
- **Flujo de uso**:
  1. `docker compose -f docker-compose.test.yml up -d --build`
  2. Esperar a que ambos servicios reporten `healthy`.
  3. Correr los checks de validación contra `http://localhost:${TEST_APP_PORT:-3001}`.
  4. `docker compose -f docker-compose.test.yml down -v` — destruye contenedores y el volumen de test, dejando el ambiente de dev intacto.
- **Verificado en la práctica**: coexiste sin conflicto con `rag-app`/`rag-postgres` de desarrollo (puertos distintos; comparten la red `rag_default`, lo cual es inofensivo), y `down -v` limpia todo sin afectar los datos de dev.

## Secuencia de specs

```
rag/specs/
  00-arquitectura-general.md        # este documento
  01-infra-postgres-pgvector.md
  02-upload-y-chunking-job.md       # v1, Implementado — histórica, ver v2
  02-upload-y-chunking-job-v2.md    # reemplaza el schema fijo de tour por schema arbitrario
  03-embedding-job.md
  04-query-endpoint.md
  05-docker-deployment.md
  06-frontend-react.md
  07-cors-configuration.md
  validations/                      # output de rag-acceptance-validator
```

Orden justificado: (1) infra primero — todo depende de tener Postgres+pgvector corriendo; (2) upload+chunking puede validarse de forma aislada creando filas en `chunks` sin necesitar aún embeddings; (3) embedding job depende de que existan chunks; (4) query depende de que existan embeddings; (5) deployment completo (Postgres+app juntos) tiene sentido una vez que el backend ya funciona localmente; (6) frontend al final porque depende de que ambos endpoints públicos tengan contrato estable.

# Luxury Horizon RAG

Sistema de **Retrieval-Augmented Generation** para responder preguntas sobre el catálogo de tours de Luxury Horizon, completamente local (embeddings + chat vía Ollama, sin depender de una API de LLM externa). Es un subproyecto independiente del sitio web principal — vive en `rag/` y no comparte infraestructura con `../website/` ni `../biolink/`.

## Cómo funciona

1. Subes un JSON con un array de objetos (tours, servicios, cualquier catálogo) vía `POST /documents/upload`.
2. Cada objeto del array se convierte en 1 chunk (`documents` → `chunks`), y cada chunk se embebe automáticamente en segundo plano usando Ollama (`qwen3-embedding`, 1536 dimensiones).
3. `POST /query` recibe una pregunta en lenguaje natural, la embebe, busca por similitud coseno (`pgvector`, índice HNSW) el chunk más cercano y:
   - si la distancia supera `SIMILARITY_THRESHOLD`, responde directamente `"datos no encontrados"` **sin llamar al LLM**;
   - si no, le pasa el chunk como contexto a `qwen3:8b` (`POST /api/chat` de Ollama) con un system prompt estricto que le prohíbe responder con nada que no venga del contexto.
4. Todo el flujo (embed, búsqueda, generación) se traza en **Langfuse** de forma best-effort — nunca rompe la respuesta si Langfuse falla o no está configurado.

Detalle completo de las decisiones de arquitectura en [`specs/00-arquitectura-general.md`](specs/00-arquitectura-general.md).

## Stack

- **Backend**: NestJS (Controller → Service → Repository/Provider), TypeScript
- **DB**: Postgres + `pgvector` (índice HNSW, distancia coseno)
- **LLM local**: Ollama — `qwen3-embedding` (embeddings) + `qwen3:8b` (chat)
- **Jobs**: `@nestjs/event-emitter` en memoria + tabla `job_status` en Postgres (sin Redis/BullMQ)
- **Observabilidad**: Langfuse Cloud (traces de embed / búsqueda / chat, prompt versionado)
- **Frontend**: React + Vite (`frontend/`), consume únicamente los dos endpoints públicos
- **Eval**: harness propio de detección de alucinaciones (`eval/`)

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/documents/upload` | Sube un JSON (array de objetos), dispara chunking + embedding |
| `GET` | `/documents` | Lista documentos subidos |
| `GET` | `/documents/:id` | Detalle de un documento |
| `GET` | `/documents/:id/chunks` | Chunks de un documento y su estado |
| `POST` | `/documents/:documentId/chunks/:chunkId/retry` | Reintenta el embedding de un chunk fallido |
| `POST` | `/documents/:id/retry-failed-chunks` | Reintenta todos los chunks fallidos de un documento |
| `POST` | `/query` | `{ question: string, topK?: number }` → `{ answer: string, matched: boolean }` |
| `GET` | `/health` | Liveness check (`{ status: 'ok' }`) |

Solo `/documents/upload` y `/query` son el contrato público que consume el frontend; el resto son de soporte/debug.

## Desarrollo local

Requiere Docker y **Ollama corriendo en el host** (no en contenedor) con los modelos `qwen3-embedding` y `qwen3:8b` descargados (`ollama pull qwen3-embedding && ollama pull qwen3:8b`).

```bash
cp .env.example .env   # completar Postgres/Langfuse/etc.

docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

Esto levanta `postgres` + `app` con **hot reload**: el contenedor corre `npm run migration:run && npm run start:dev` y el volumen `./src` está montado, así que los cambios en `.ts` se recargan solos. Backend en `http://localhost:3000`.

**Importante:** editar `.env` no se aplica solo — hay que recrear el contenedor (`docker restart` NO relee `.env`):

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --no-deps app
```

**Frontend** (`frontend/`, Vite):

```bash
cd frontend
cp .env.example .env
npm install && npm run dev
```

## Variables de entorno

Ver [`.env.example`](.env.example) para la lista completa y sus defaults (Postgres, Ollama, `VECTOR_DIM`, `DEFAULT_TOP_K`, `SIMILARITY_THRESHOLD`, Langfuse, CORS). Notas:

- `OLLAMA_BASE_URL` dentro de Docker debe ser `http://host.docker.internal:11434` (Ollama vive en el host) — ya viene fijo así en `docker-compose.yml`, no se lee de `.env` para ese servicio.
- `LANGFUSE_HOST` es el nombre canónico; `LANGFUSE_BASE_URL` es un alias deprecado que se sigue soportando. Las API keys de Langfuse son específicas por cluster/región (`cloud.langfuse.com` vs `us.cloud.langfuse.com`) — si ves `Invalid credentials` en los logs, casi siempre es un mismatch de host/región, no una llave mal copiada.

## Testing

```bash
npm test              # unit tests (Jest)
npm run test:e2e       # e2e
npm run test:cov       # cobertura
```

Ambiente de pruebas de integración aislado (no toca los datos de dev):

```bash
docker compose -f docker-compose.test.yml up -d --build
docker compose -f docker-compose.test.yml down -v
```

### Eval harness de alucinaciones

`rag/eval/golden-qa.json` es un dataset fijo de preguntas ("golden Q&A") con comportamiento esperado, incluyendo casos `hallucination-bait-*` diseñados para detectar si el modelo inventa datos de tours que no existen. Corre contra el sistema real (no mocks):

```bash
npm run eval
```

Guarda un reporte JSON por corrida en `eval/reports/` (gitignored) y termina con exit code `1` si algo falla — útil como gate manual antes de deploy. Detalle en [`specs/10-eval-harness-hallucinaciones.md`](specs/10-eval-harness-hallucinaciones.md).

## Monitoreo

No hay dashboard de métricas de infraestructura (CPU/memoria) — el monitoreo "en vivo" del pipeline es vía **Langfuse**: cada `POST /query` genera un trace completo (embed, búsqueda con distancias por chunk, si cruzó el umbral de similitud, y la generación del chat con el prompt versionado exacto que la produjo). `GET /health` es solo un liveness check simple, usado por el healthcheck de Docker.

## Producción

```bash
docker compose -f docker-compose.yml up -d --build
```

Usa el stage `runner` del `Dockerfile` (imagen slim, sin devDependencies). Corre migraciones y arranca `node dist/main`.

## Desarrollo guiado por specs

Este proyecto sigue un flujo *spec-driven*: cada feature se redacta como spec en [`specs/`](specs/) y se aprueba antes de implementarse. Ver [`specs/00-arquitectura-general.md`](specs/00-arquitectura-general.md) para el contrato completo y el orden de las specs; `specs/validations/` tiene la evidencia de verificación de cada una.

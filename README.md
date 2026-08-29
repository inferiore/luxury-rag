# Luxury Horizon RAG

Sistema de **Retrieval-Augmented Generation** para responder preguntas sobre el catálogo de tours de Luxury Horizon. El proveedor de embeddings/chat es intercambiable vía `LLM_PROVIDER`: por defecto corre completamente local con Ollama, o puede apuntar a cualquier proveedor compatible con la API de OpenAI (OpenRouter, Groq, etc.) sin cambiar código. Es un subproyecto independiente del sitio web principal — vive en `rag/` y no comparte infraestructura con `../website/` ni `../biolink/`.

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
- **LLM**: intercambiable vía `LLM_PROVIDER` — Ollama local (`qwen3-embedding` + `qwen3:8b`, default) u OpenAI-compatible en la nube (OpenRouter, Groq, etc.)
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

Solo `/documents/upload` y `/query` son el contrato público que consume el frontend; el resto son de soporte/debug. **Todos requieren `Authorization: Bearer <api-key>` excepto `/health`.**

## Autenticación

La API se identifica por **API key estática por cliente** (no OAuth2/JWT — no hace falta usuario/contraseña ni renovar tokens: enviar la key en cada request ya identifica quién llama). Header requerido en toda ruta excepto `GET /health`:

```
Authorization: Bearer <api-key>
```

**Gestión de clientes**: no hay un endpoint HTTP de administración — los clientes se provisionan corriendo el seed contra la base de datos:

```bash
npm run seed:api-clients
```

Es idempotente (no toca un cliente que ya existe) y, para cada cliente nuevo, **imprime la key en consola una sola vez** — el backend solo guarda su hash SHA-256, la key cruda no se puede recuperar después de ese momento.

| Cliente | Perfil | `/query` | `/documents/upload` |
|---|---|---|---|
| `demo-frontend` | Público (portafolio) | 1 cada 5 min | 1 cada 30 min |
| `luxury-agent-tour-specialist` | Backend propio, server-to-server | Ilimitado | Ilimitado |

El cupo del cliente `demo-frontend` se cuenta **globalmente por key**, no por visitante/IP — todos los visitantes que usan esa key (embebida en el bundle público del frontend) comparten el mismo contador. Es una decisión deliberada: aunque alguien extraiga la key de las devtools del navegador, no puede superar el cupo, porque sigue siendo la misma key con el mismo contador compartido.

El estado del rate limit vive **en memoria del proceso** y se reinicia en cada redeploy/restart — mismo trade-off ya aceptado en este repo para el estado de jobs (ver `specs/00-arquitectura-general.md`), evita depender de Redis solo para esto.

Respuestas de error:
- `401 Unauthorized` — falta el header, está mal formado, la key no existe, o el cliente está inactivo.
- `429 Too Many Requests` — cupo excedido; incluye el header `Retry-After` (segundos hasta que se libera).

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
cp .env.example .env   # completar VITE_API_KEY con la key de `demo-frontend` (ver sección Autenticación)
npm install && npm run dev
```

## Variables de entorno

Ver [`.env.example`](.env.example) para la lista completa y sus defaults (Postgres, Ollama, `VECTOR_DIM`, `DEFAULT_TOP_K`, `SIMILARITY_THRESHOLD`, Langfuse, CORS). Notas:

- `BASE_URL` dentro de Docker con `LLM_PROVIDER=ollama` debe ser `http://host.docker.internal:11434` (Ollama vive en el host) — en dev (`docker-compose.dev.yml`) ya viene fijo así, no se lee de `.env` para ese servicio; en producción (`docker-compose.yml`) sí se lee de `.env` porque también puede apuntar a un proveedor cloud, así que si `LLM_PROVIDER=ollama` en producción hay que fijarlo explícitamente ahí.
- `POSTGRES_SSL` (`false` por defecto) activa TLS (`rejectUnauthorized: false`) en la conexión a Postgres — requerido para Supabase (`POSTGRES_SSL=true`). En dev (`docker-compose.dev.yml`) se hardcodea a `false` junto con `POSTGRES_HOST`/`PORT` (Postgres local, sin TLS); en producción se lee de `.env` y debe ser `true` para conectar a Supabase.
- `LLM_PROVIDER` (`ollama` por defecto, o `openai`) elige el proveedor que implementa TANTO `embed()` como `chat()` — no hay selección independiente por capacidad. Con `openai` se activa un cliente HTTP genérico compatible con la API de OpenAI (OpenRouter, Groq, Together, LM Studio, o la propia OpenAI), configurado vía `BASE_URL`/`LLM_API_KEY`/`CHAT_MODEL`/`EMBEDDING_MODEL` — los mismos 4 nombres de variable usados por Ollama, ya que un mismo `.env` solo corre un proveedor a la vez. No todos los proveedores compatibles exponen `/embeddings` (ej. OpenRouter no lo tiene) — elige uno que soporte ambos endpoints si vas a usar `openai` para todo el pipeline. El cliente siempre envía `dimensions` (= `VECTOR_DIM`) en el body de `/embeddings`, igual que `OllamaProvider` — verificado contra el endpoint OpenAI-compatible de Gemini (`gemini-embedding-001`, trunca 3072→1536 correctamente). El modelo de embedding elegido debe soportar truncamiento a ese tamaño o producirlo nativamente; si un proveedor rechaza `dimensions` como parámetro desconocido, ese modelo no es compatible con este cliente tal cual.
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

**Base de datos**: producción se conecta a un proyecto **Supabase Postgres** administrado (conexión directa, sin pooler) — este compose ya no levanta ningún contenedor local de Postgres. El `.env` real usado en el servidor debe tener `POSTGRES_HOST`/`PORT`/`USER`/`PASSWORD`/`DB` apuntando a las credenciales reales de Supabase y `POSTGRES_SSL=true` (ver `.env.example` para el detalle de cada valor).

Antes del primer deploy, la extensión `vector` de Postgres debe estar disponible en el proyecto Supabase. La migración inicial ya corre `CREATE EXTENSION IF NOT EXISTS vector;` y `pgcrypto` de forma idempotente, así que normalmente esto simplemente funciona; si falla por permisos, actívala manualmente desde el dashboard de Supabase (Database → Extensions) o el SQL Editor.

**Nota operacional**: el free tier de Supabase pausa el proyecto tras 7 días de inactividad. Si la app empieza a fallar después de una semana sin tráfico, no es un bug — hay que reanudar el proyecto desde el dashboard de Supabase.

### Frontend servido por el mismo contenedor

`docker compose ... up -d --build` ahora también compila el frontend (`frontend/`, stage `frontend-builder` del `Dockerfile`) y lo sirve como estáticos desde el propio backend (`ServeStaticModule`, ruta `public/`) — no hay deploy separado tipo Netlify/Vercel. `VITE_API_BASE_URL`/`VITE_API_KEY` ahora también deben estar en el `.env` de la **raíz** de `rag/` (no solo en `frontend/.env`), porque el build de Docker los necesita como build args. En producción `VITE_API_BASE_URL` debe quedar **vacío**: frontend y backend comparten origen detrás de nginx, así que las rutas relativas (`fetch('/query')`) funcionan solas.

### nginx + Let's Encrypt (`rag.luxuryhorizon.lat`)

`app` ya no publica su puerto directo al host (`expose: "3000"` interno solamente) — nginx es el único punto de entrada público, terminando TLS y haciendo proxy a `app:3000`. Los servicios `nginx`/`certbot` están gateados con `profiles: ["production"]` (evita que `docker compose -f docker-compose.yml -f docker-compose.dev.yml up` los levante también en dev, donde no existen certificados) — el `.env` real del servidor debe tener `COMPOSE_PROFILES=production` para que el comando de arriba los incluya.

**Primer deploy en un servidor nuevo** (una sola vez, manual, no automatizado por CI):
```bash
./init-ssl.sh
```
Emite el certificado inicial de `rag.luxuryhorizon.lat` (requiere que el registro DNS A ya apunte al servidor) y levanta el stack completo con HTTPS. Certbot renueva automáticamente cada 12h desde entonces.

Prerrequisito del servidor: Docker + el plugin de Docker Compose ya instalados (manual, no automatizado aquí).

### CI/CD

`.github/workflows/deploy.yml` — en cada push a `main`: corre `npm ci && npm run build && npm test`, y solo si pasa, hace SSH al servidor y corre `git pull && docker compose up -d --build`. A diferencia del pipeline del sitio principal (que hardcodea IP/usuario en el YAML), acá host/usuario/ruta también van como secrets, no solo la llave SSH. Secrets a configurar en `inferiore/luxury-rag` → Settings → Secrets and variables → Actions:

| Secret | Contenido |
|---|---|
| `RAG_SSH_HOST` | IP del servidor |
| `RAG_SSH_USER` | Usuario SSH |
| `RAG_DEPLOY_SSH_KEY` | Llave privada SSH |
| `RAG_DEPLOY_PATH` | Ruta del repo clonado en el servidor |

## Desarrollo guiado por specs

Este proyecto sigue un flujo *spec-driven*: cada feature se redacta como spec en [`specs/`](specs/) y se aprueba antes de implementarse. Ver [`specs/00-arquitectura-general.md`](specs/00-arquitectura-general.md) para el contrato completo y el orden de las specs; `specs/validations/` tiene la evidencia de verificación de cada una.

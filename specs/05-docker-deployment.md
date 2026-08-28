# 05 — Deployment completo (Docker)

## Estado
Implementado

Validado: 2026-08-27 — PASS 7/7 criterios. Ver `rag/specs/validations/05-docker-deployment.validation.md`.

## Contexto y objetivo

Con el backend NestJS funcionando localmente (specs 02-04 implementadas), esta spec dockeriza la aplicación completa para que `rag/` se pueda levantar con un solo comando tanto en desarrollo (hot reload) como en un entorno de producción, reutilizando y extendiendo `rag/docker-compose.yml` (que hoy solo tiene el servicio `postgres`, de la spec 01) — nunca tocando los `docker-compose*.yml` de la raíz del repo, que pertenecen al sitio web principal.

## Diseño técnico

- `rag/Dockerfile` — build multi-stage: stage `builder` instala dependencias y corre `npm run build`; stage final copia solo `dist/` + `node_modules` de producción + `package.json`, corre `node dist/main.js`. Imagen base `node:20-alpine` (o la LTS vigente).
- `rag/docker-compose.yml` se extiende con el servicio `app`:
  - `build: .` (usa el Dockerfile de arriba).
  - `depends_on: postgres: condition: service_healthy`.
  - Variables de entorno inyectadas desde `.env` (mismas claves que `rag/.env.example`).
  - `ports: "${PORT:-3000}:3000"`.
  - Healthcheck propio: `GET /health` (creado en spec 02) vía `wget`/`curl` dentro del contenedor.
  - `restart: unless-stopped`.
- **Ollama corre en el host, no en un contenedor.** Cuando `app` corre dockerizado, `OLLAMA_BASE_URL` debe ser `http://host.docker.internal:11434` (funciona en Docker Desktop para Mac, el entorno de Eder) en vez de `http://localhost:11434`. Esto debe quedar documentado explícitamente en `rag/.env.example` con un comentario, para evitar el error confuso de "Ollama no responde" al dockerizar.
- **Modo desarrollo con hot reload**: `rag/docker-compose.dev.yml` como *override* de Compose (se usa con `docker compose -f docker-compose.yml -f docker-compose.dev.yml up`), NO un archivo duplicado — sigue el patrón estándar de Compose de overrides parciales. Este override:
  - Monta `./src:/app/src` como volumen (bind mount) sobre el servicio `app`.
  - Cambia el comando a `npm run start:dev` (watch mode de NestJS) en vez de `node dist/main.js`.
- Secretos: todo vía `.env` (gitignored); `rag/.env.example` se mantiene sincronizado con las variables que el servicio `app` realmente consume.

## Contratos de API

N/A — esta spec no agrega ni modifica endpoints, solo su empaquetado y despliegue.

## Esquema de datos

N/A — no modifica el esquema de base de datos.

## Criterios de aceptación

1. `docker compose -f rag/docker-compose.yml build` construye la imagen de `app` sin errores.
2. `docker compose -f rag/docker-compose.yml up -d` levanta `postgres` y `app`; ambos alcanzan estado `healthy` (`docker compose ps`).
3. Con la app dockerizada, `curl http://localhost:${PORT}/health` responde HTTP 200 desde el host.
4. Con la app dockerizada, un `POST /query` real (contra un chunk ya embebido) devuelve una respuesta válida — confirma que `OLLAMA_BASE_URL=http://host.docker.internal:11434` efectivamente alcanza el Ollama del host desde dentro del contenedor.
5. `docker compose -f rag/docker-compose.yml -f rag/docker-compose.dev.yml up -d` levanta la app en modo watch; modificar un archivo bajo `rag/src/` (ej. un log trivial) hace que `docker compose logs -f app` muestre un rebuild/restart automático sin necesidad de `docker compose build`.
6. `rag/.env.example` incluye todas las variables que el servicio `app` consume en el compose, con el comentario sobre `host.docker.internal` para `OLLAMA_BASE_URL`.
7. No hay ninguna credencial real commiteada; `.env` sigue cubierto por `.gitignore`.

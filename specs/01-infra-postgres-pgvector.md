# 01 — Infraestructura: Postgres + pgvector

## Estado
Implementado

## Contexto y objetivo

Antes de escribir cualquier código de NestJS se necesita una base de datos Postgres con la extensión `pgvector` disponible, corriendo localmente vía Docker. Esta spec es la base de la que dependen todas las demás — sin ella no hay dónde persistir nada.

Alcance explícito de esta spec: **solo el contenedor de Postgres y la extensión `vector` habilitada**. No incluye ningún endpoint HTTP ni código de aplicación NestJS (eso empieza en la spec 02). No incluye tampoco el servicio de la app en el docker-compose — solo Postgres.

**Decisión explícita: esta spec NO crea las tablas (`documents`, `chunks`, `job_status`) ni el índice HNSW.** El esquema de aplicación se crea exclusivamente vía **migraciones de TypeORM**, dentro del proyecto NestJS — no hay SQL plano paralelo que mantener sincronizado con el ORM. La creación de tablas queda a cargo de `nestjs-rag-developer` en la spec 02 (o en una spec de bootstrap del proyecto NestJS si Eder prefiere separarlo), cuando ya exista `rag/src/database/migrations/`. El esquema completo (columnas, tipos, índices) sigue documentado como referencia en `00-arquitectura-general.md` para que esa migración lo implemente fielmente.

## Diseño técnico

- Contenedor único `postgres` en `rag/docker-compose.yml`, imagen `pgvector/pgvector:pg16` (trae la extensión `vector` preinstalada, solo falta habilitarla con `CREATE EXTENSION`).
- La extensión se habilita vía un script SQL montado en `docker-entrypoint-initdb.d` (`rag/db/init/001-create-extension.sql`), que corre automáticamente la primera vez que se crea el volumen de datos. Este es el único SQL que vive fuera de TypeORM, porque `CREATE EXTENSION` es un requisito de la base de datos en sí (necesita privilegios de superusuario que el rol de la app podría no tener), no del esquema de la aplicación.
- **Las tablas `documents`, `chunks`, `job_status` y el índice HNSW NO se crean en esta spec.** Se crean vía migración de TypeORM cuando exista el proyecto NestJS (spec 02), como el único origen de verdad del esquema de aplicación — evita mantener SQL plano y migraciones TypeORM sincronizados a mano.
- Dimensión del vector acordada para esa futura migración: `VECTOR_DIM=1536` (columna `chunks.embedding VECTOR(1536)`). Ver `00-arquitectura-general.md` para el porqué: `qwen3-embedding` produce 4096 dimensiones nativamente pero el endpoint `/api/embed` de Ollama acepta un parámetro `dimensions` que trunca el vector de salida (Matryoshka), verificado empíricamente que devuelve 1536 reales al pedirlo.

## Contratos de API

N/A — esta spec no expone ningún endpoint HTTP.

## Esquema de datos

N/A en esta spec — el esquema de `documents`, `chunks` y `job_status` queda documentado como referencia en `rag/specs/00-arquitectura-general.md` para que la migración de TypeORM de la spec 02 lo implemente fielmente. Esta spec solo garantiza que la extensión `vector` está disponible en la base de datos.

Archivos que esta spec crea:
- `rag/docker-compose.yml` (servicio `postgres` únicamente)
- `rag/.env.example`
- `rag/db/init/001-create-extension.sql`

## Criterios de aceptación

1. `docker compose -f rag/docker-compose.yml up -d` levanta un contenedor `postgres` que pasa a estado `healthy` (verificable con `docker compose ps`).
2. `docker exec <contenedor> psql -U $POSTGRES_USER -d $POSTGRES_DB -c "\dx"` lista la extensión `vector` como instalada.
3. Al detener y volver a levantar el contenedor (`docker compose down && docker compose up -d`, sin borrar el volumen), la extensión sigue instalada — el volumen nombrado sobrevive al ciclo de vida del contenedor.
4. `rag/.env.example` contiene todas las variables necesarias para levantar el compose (`POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`), sin credenciales reales.
5. No existe ningún archivo SQL de creación de tablas de aplicación (`documents`/`chunks`/`job_status`) fuera de las migraciones de TypeORM del proyecto NestJS — esta spec solo debe dejar `001-create-extension.sql` en `rag/db/init/`.

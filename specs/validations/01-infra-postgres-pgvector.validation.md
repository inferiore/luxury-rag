# Validación — 01-infra-postgres-pgvector

Fecha: 2026-08-27
Veredicto general: PASS (5/5 criterios)

## Criterio 1: `docker compose up -d` levanta un contenedor `postgres` que pasa a estado `healthy`
**Resultado:** PASS
**Comando:** `docker compose up -d && docker compose ps`
**Evidencia:**
```
NAME           IMAGE                    COMMAND                  SERVICE    CREATED         STATUS                   PORTS
rag-postgres   pgvector/pgvector:pg16   "docker-entrypoint.s…"   postgres   5 seconds ago   Up 5 seconds (healthy)   0.0.0.0:5432->5432/tcp
```

## Criterio 2: la extensión `vector` está instalada
**Resultado:** PASS
**Comando:** `docker exec rag-postgres psql -U rag_user -d rag_db -c "\dx"`
**Evidencia:**
```
  Name   | Version |   Schema   |                     Description                      
---------+---------+------------+------------------------------------------------------
 plpgsql | 1.0     | pg_catalog | PL/pgSQL procedural language
 vector  | 0.8.1   | public     | vector data type and ivfflat and hnsw access methods
```

## Criterio 3: los datos/extensión persisten tras `down && up` sin borrar el volumen
**Resultado:** PASS
**Comando:** `docker compose down && docker compose up -d && docker exec rag-postgres psql -U rag_user -d rag_db -c "\dx"`
**Evidencia:** El volumen nombrado `rag_rag_pgdata` no se recreó (log de `docker compose up` no mostró "Volume ... Creating" en el segundo arranque, solo en el primero); la extensión `vector` sigue listada tras el reinicio del contenedor.

## Criterio 4: `.env.example` contiene las variables necesarias sin credenciales reales
**Resultado:** PASS
**Comando:** `cat rag/.env.example`
**Evidencia:** Contiene `POSTGRES_HOST/PORT/USER/PASSWORD/DB` (más las variables ya documentadas en 00-arquitectura-general.md para Ollama/Langfuse/app, incluidas de una vez para no reeditar el archivo en cada spec futura). `POSTGRES_PASSWORD=changeme` es un placeholder, no una credencial real.

## Criterio 5: no hay SQL de tablas de aplicación fuera de TypeORM
**Resultado:** PASS
**Comando:** `find rag/db -type f`
**Evidencia:**
```
rag/db/init/001-create-extension.sql
```
Único archivo SQL del proyecto; solo contiene `CREATE EXTENSION IF NOT EXISTS vector;`.

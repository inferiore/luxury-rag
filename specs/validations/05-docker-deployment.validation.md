# Validación — 05-docker-deployment

Fecha: 2026-08-27
Veredicto general: PASS (7/7 criterios)

## Verificación previa (fuera de la spec pero crítica): archivos de la raíz no tocados

**Comando:** `git status --short docker-compose.yml docker-compose.dev.yml nginx.conf && git diff -- docker-compose.yml docker-compose.dev.yml nginx.conf`
**Evidencia:**
```
(sin salida en ambos casos — sin cambios, sin diff)
```
`git log -3 --oneline -- docker-compose.yml docker-compose.dev.yml nginx.conf` solo muestra commits previos del sitio web (nada relacionado con rag). Confirmado: `rag-deployment-engineer` no modificó los compose/nginx de la raíz.

## Criterio 1: `docker compose -f rag/docker-compose.yml build` construye la imagen de `app` sin errores

**Resultado:** PASS
**Comando:** `docker compose -f rag/docker-compose.yml build --no-cache` (forzado sin cache, no solo el build con cache que ya tenía el implementador)
**Evidencia:**
```
#14 [app builder 7/7] RUN npm run build
#14 0.173 > rag@0.0.1 build
#14 0.173 > nest build
#14 DONE 2.4s
...
#16 exporting to image ... naming to docker.io/library/rag-app:latest done
 app  Built
```
Build multi-stage (`builder` con `npm ci` + `npm run build`; `runner` con `npm ci --omit=dev` + `COPY --from=builder /app/dist`) completa sin errores desde cero.

## Criterio 2: `docker compose -f rag/docker-compose.yml up -d` levanta `postgres` y `app`; ambos alcanzan `healthy`

**Resultado:** PASS
**Comando:** `docker compose -f rag/docker-compose.yml down && docker compose -f rag/docker-compose.yml up -d` seguido de polling de `docker compose ps`
**Evidencia:**
```
--- attempt 1 ---
rag-app: Up 4 seconds (health: starting)
rag-postgres: Up 10 seconds (healthy)
--- attempt 2 ---
rag-app: Up 8 seconds (healthy)
rag-postgres: Up 13 seconds (healthy)
```

## Criterio 3: `curl http://localhost:${PORT}/health` responde HTTP 200 desde el host

**Resultado:** PASS
**Comando:** `curl -s -i http://localhost:3000/health`
**Evidencia:**
```
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
{"status":"ok"}
```

## Criterio 4: `POST /query` real contra un chunk embebido devuelve respuesta válida, confirmando que `host.docker.internal:11434` alcanza Ollama del host

**Resultado:** PASS
**Comandos:**
```
curl -s -i -X POST http://localhost:3000/documents/upload -F "file=@qa-tour.json;type=application/json"
docker exec rag-postgres psql -U rag_user -d rag_db -c "SELECT id, status, total_items FROM documents WHERE id='...';"
docker exec rag-postgres psql -U rag_user -d rag_db -c "SELECT id, status, (embedding IS NOT NULL) AS has_embedding FROM chunks WHERE document_id='...';"
curl -s -i -X POST http://localhost:3000/query -H "Content-Type: application/json" -d '{"question": "Cuentame sobre el QA Validation Tour ZQX9"}'
docker compose -f docker-compose.yml logs app --tail 80 | grep -iE "ollama|error|host.docker"
```
Fixture usado: `qa-tour.json` con un item sintético (`nombre: "QA Validation Tour ZQX9"`, descripción, precio, lugar de embarque) subido vía `POST /documents/upload`.
**Evidencia:**
```
POST /documents/upload → 202 {"documentId":"3e841d58-...","totalItems":1,"status":"processing"}

documents: status=done, total_items=1
chunks:    status=done, has_embedding=t, content_preview="Tour: QA Validation Tour ZQX9. Descripción: Tour de prueba QA..."

POST /query → 200
{"answer":"El **QA Validation Tour ZQX9** es un tour de prueba para validar el flujo end-to-end dockerizado. Incluye un paseo en yate por la bahia de Cartagena al atardecer, con snorkel incluido. El precio es de **350.000 COP / 90 USD**. El lugar de embarque es el **Muelle QA Test Dock**, en **Cartagena**.","matched":true}

logs app: sin errores; "OllamaModule dependencies initialized +27ms" (arranque limpio)
```
Documento y chunk de prueba fueron eliminados después con `DELETE FROM chunks/documents WHERE id='3e841d58-...'` (confirmado `count=0` tras el borrado).

## Criterio 5: override dev (`docker-compose.dev.yml`) levanta la app en modo watch; editar un archivo bajo `rag/src/` dispara rebuild/restart automático visto en `docker compose logs -f app`, sin `docker compose build`

**Resultado:** PASS
**Comandos:**
```
docker compose -f rag/docker-compose.yml down
docker compose -f rag/docker-compose.yml -f rag/docker-compose.dev.yml up -d
docker images | grep rag-app   # confirma tags separados
# edición: agregar console.log('QA_HOT_RELOAD_MARKER_9f3a') en src/health/health.controller.ts
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs app --tail 15
curl -s http://localhost:3000/health
# revertir el archivo a su contenido original
```
**Evidencia:**
```
docker images:
rag-app   latest   9796aee40d56   382MB
rag-app   dev      e03720ce1260   667MB   <- tag separado, no pisa :latest

logs (tras editar el archivo, sin correr build):
[Nest] 94 - ... [NestFactory] Starting Nest application...
...
[Nest] 94 - ... [NestApplication] Nest application successfully started +3ms
QA_HOT_RELOAD_MARKER_9f3a   <- disparado por el healthcheck automático del propio contenedor tras el restart

curl /health posterior → {"status":"ok"} y el log confirma otra ejecución de QA_HOT_RELOAD_MARKER_9f3a
```
El número de instancia Nest cambió de 69 (arranque inicial) a 94 (tras la edición), confirmando recompilación + reinicio automático del watcher (`nest start --watch`) sin invocar `docker compose build`. Archivo revertido a su versión original tras la prueba (`git status --short rag/src/health/` no muestra diffs de contenido, el directorio completo sigue como `??` por ser `rag/` no trackeado aún).

## Criterio 6: `rag/.env.example` incluye todas las variables que `app` consume en el compose, con el comentario sobre `host.docker.internal` para `OLLAMA_BASE_URL`

**Resultado:** PASS
**Comando:** comparación manual de las claves `environment:` del servicio `app` en `rag/docker-compose.yml` contra `rag/.env.example`
**Evidencia:**
Variables consumidas por `app` en compose: `NODE_ENV, PORT, POSTGRES_HOST*, POSTGRES_PORT*, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, OLLAMA_BASE_URL*, EMBEDDING_MODEL, CHAT_MODEL, VECTOR_DIM, DEFAULT_TOP_K, SIMILARITY_THRESHOLD, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST` (`*` = hardcodeadas en compose, no leídas de `.env`, por diseño documentado).
Todas están presentes en `rag/.env.example`. El comentario explícito existe:
```
# --- Ollama ---
# ... When the app runs dockerized (docker compose up, spec 05), it must
# reach Ollama at http://host.docker.internal:11434 instead — localhost
# from inside a container refers to the container itself, not the host,
# which is the classic confusing "Ollama no responde" failure.
OLLAMA_BASE_URL=http://localhost:11434
```
Nota: el diseño de hardcodear `POSTGRES_HOST/PORT` y `OLLAMA_BASE_URL` en `docker-compose.yml` en vez de leerlos de `.env` está documentado tanto en el compose como en `.env.example`, y es consistente con la justificación dada por el implementador (evitar que un valor "host" se filtre al contenedor). No es un incumplimiento del criterio: el criterio pide que las variables *existan* en `.env.example` con el comentario, lo cual se cumple.

## Criterio 7: no hay ninguna credencial real commiteada; `.env` sigue cubierto por `.gitignore`

**Resultado:** PASS
**Comandos:**
```
git check-ignore -v rag/.env
git ls-files rag | grep -i "\.env$"
git log --all --oneline -- rag
grep -rIn "AKIA\|BEGIN PRIVATE KEY\|sk-[a-zA-Z0-9]{20,}" rag --include="*.ts" --include="*.yml" --include="*.example" | grep -v node_modules
```
**Evidencia:**
```
rag/.gitignore:9:.env	rag/.env          <- .env está ignorado
(sin salida) → .env no está en el índice de git
(sin salida) → rag/ no tiene commits previos (directorio completo aún sin trackear, "??" en git status)
(sin salida) → sin patrones de credenciales reales encontrados
```
`.env.example` solo contiene placeholders (`POSTGRES_PASSWORD=changeme`, claves de Langfuse vacías).

## Limpieza post-validación

- Documento y chunk de prueba (`QA Validation Tour ZQX9`, id `3e841d58-...`) eliminados de Postgres.
- `src/health/health.controller.ts` revertido a su contenido original.
- Stack dev (`rag-app-dev`) bajado; sistema devuelto a modo producción vía `docker compose -f rag/docker-compose.yml up -d`.
- Estado final verificado: `rag-app` y `rag-postgres` `Up ... (healthy)`, sin contenedores huérfanos (`docker ps -a` solo muestra esos dos), `documents`/`chunks` en Postgres con el conteo previo a la prueba (7 documentos / 19 chunks del catálogo real, sin residuos de QA).
- Archivos `docker-compose.yml`, `docker-compose.dev.yml`, `nginx.conf` de la raíz del repo verificados sin modificaciones (`git status`/`git diff` vacíos).

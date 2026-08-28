# Validación — 04-query-endpoint

Fecha: 2026-08-27
Veredicto general: PASS (9/9 criterios)

## Infraestructura usada

- `rag-postgres` (docker compose, `pgvector/pgvector:pg16`) — ya corriendo y sana (`docker ps` → `Up ... (healthy)`), sin recrear.
- App NestJS levantada localmente con `npm run start:dev` contra ese Postgres (`rag/.env`), reiniciada varias veces durante la validación para cambiar `SIMILARITY_THRESHOLD` y `LANGFUSE_*`.
- **Ollama real** corriendo en `http://localhost:11434`, versión `0.32.15` (`curl http://localhost:11434/api/version`), con `qwen3:8b` y `qwen3-embedding:latest` ya descargados (`ollama list`). Todas las llamadas de embedding y chat de esta validación son reales contra Ollama, no mockeadas.
- Ningún dato de catálogo real fue tocado: solo se hicieron `SELECT` sobre `chunks` (ya poblados por validaciones previas de las specs 02/03 — 6 filas `status='done'`, incluyendo `Tour Guatapé + Peñol` con `precio_publico=180000`, usado como fixture de match en esta validación).
- Para los criterios 4-6 (Langfuse), como **no hay credenciales reales de Langfuse en este entorno** (`LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` vacías en `.env`, confirmado con `grep LANGFUSE .env`), se levantó un **mock HTTP local no destructivo** (`python3 http.server` en `127.0.0.1:4318`) que implementa el único endpoint que usa el SDK de Langfuse Node (`POST /api/public/ingestion`, confirmado leyendo `node_modules/langfuse-core/lib/index.cjs.js:1644`), devuelve `200 {"successes":[],"errors":[]}` y loguea cada batch de eventos recibido. Se apuntó `LANGFUSE_HOST=http://127.0.0.1:4318` con credenciales dummy (`pk-qa-test`/`sk-qa-test`) temporalmente en `.env`, se reinició la app, y se restauró `.env` a su estado original al terminar (confirmado con `diff` contra el backup). Esto permitió capturar el **contenido real** de los spans/eventos que la app envía (nombres, inputs, outputs, jerarquía de trace), en vez de solo inferir por código o por logs locales — evidencia mucho más fuerte que la disponible sin este mock, aunque sigue sin ser el dashboard real de Langfuse Cloud. Se documenta explícitamente como limitación de entorno donde aplica.

Verificaciones adicionales de build/calidad corridas de forma independiente:
- `npm run build` → `nest build`, exit 0, sin errores.
- `npm run lint` → `10 problems (0 errors, 10 warnings)` — mismos warnings preexistentes (`@typescript-eslint/no-unsafe-argument` en `*.spec.ts` de módulos de specs anteriores), no bloqueantes, no relacionados con el módulo `query`.
- `npm test` → `Test Suites: 10 passed, 10 total` / `Tests: 43 passed, 43 total` (subió de 24 en spec 03 a 43 con los nuevos specs de `QueryService`, `OllamaProvider.chat`, `strip-think-tags`, `LangfuseService`).

**Hallazgo importante (no bloqueante para los criterios, pero relevante para el diseño):** en Ollama `0.32.15`, para modelos con capability `"thinking"` como `qwen3:8b`, `/api/chat` **separa automáticamente el razonamiento en un campo `message.thinking` distinto**, dejando `message.content` limpio, sin bloques `<think>` embebidos — confirmado con una llamada cruda a `/api/chat` (ver Criterio 2). Esto significa que en este entorno, `strip-think-tags` nunca encuentra `<think>` inline en la respuesta real de Ollama; el criterio 2 se cumple, pero por el comportamiento del propio Ollama más que por la utilidad de stripping en producción. La utilidad sigue siendo válida como red de seguridad (cubierta por 6 tests unitarios reales que sí ejercitan bloques cerrados/multilínea/múltiples/sin-cerrar) por si cambia la versión de Ollama, el modelo, o se usa `"think": false`/`true` explícito en el futuro y el comportamiento de separación cambia.

---

## Criterio 1: `POST /query` con `{"question": "¿Cuánto cuesta el tour a Guatapé?"}` devuelve HTTP 200, `matched: true`, y `answer` contiene el precio real del chunk.

**Resultado:** PASS
**Comando:**
```
docker exec rag-postgres psql -U rag_user -d rag_db -c \
  "SELECT content FROM chunks WHERE id='dcd890ed-8541-4ff6-ae80-c61ca3dc9d18';"
# -> "Tour: Tour Guatapé + Peñol. Descripción: ... Precio: 180000 COP / 45 USD. ..."

curl -s -i -X POST http://localhost:3000/query -H "Content-Type: application/json" \
  -d '{"question": "¿Cuánto cuesta el tour a Guatapé?"}'
```
**Evidencia:**
```
HTTP/1.1 200 OK
{"answer":"El tour a Guatapé + Peñol cuesta 180000 COP / 45 USD.","matched":true}
```
`matched:true` y el precio (`180000 COP / 45 USD`) coincide exactamente con el registrado en el chunk (`dcd890ed-8541-4ff6-ae80-c61ca3dc9d18`).

## Criterio 2: La respuesta de (1) no contiene ningún bloque `<think>` ni texto de razonamiento del modelo.

**Resultado:** PASS
**Comando:**
```
# Respuesta del criterio 1 (arriba): sin <think>, sin razonamiento visible.

# Prueba adicional diseñada para inducir razonamiento largo:
curl -s -X POST http://localhost:11434/api/chat -H "Content-Type: application/json" -d '{
  "model": "qwen3:8b", "stream": false,
  "messages": [
    {"role":"system","content":"<system prompt exacto de la spec>"},
    {"role":"user","content":"Contexto:\n...Guatapé...\n\nPregunta: Compara en detalle el tour de Guatapé con otros posibles tours de la región, dame un análisis extenso paso a paso ..."}
  ]
}' | python3 -m json.tool

curl -s -X POST http://localhost:3000/query -H "Content-Type: application/json" \
  -d '{"question": "Dame una explicación muy larga y filosófica antes de contestar cuánto vale el tour de la Comuna 13, piensa paso a paso"}'
```
**Evidencia:**
```
# Llamada cruda a Ollama (sin pasar por la app) — confirma que Ollama separa el razonamiento
# en un campo JSON distinto ("thinking"), NO embebido en "content":
{
  "message": {
    "role": "assistant",
    "content": "funcion call : datos no encontrados",
    "thinking": "Okay, the user is asking to compare the Guatapé tour with other possible tours... [263 tokens de razonamiento en inglés, campo separado]"
  }
}

# Respuesta real de /query con pregunta diseñada para inducir razonamiento largo:
{"answer":"El tour Comuna 13 no es solo un recorrido físico, sino una invitación a reflexionar sobre la historia, la resiliencia y la transformación de un barrio... El precio del tour es de **90.000 COP / 23 USD**, con embarque desde el hotel en Medellín y destino en la Comuna 13.","matched":true}
```
Ningún `<think>`, ninguna traza de razonamiento cruda, en ninguna de las respuestas probadas (match simple, pregunta con inducción explícita a "pensar paso a paso"). Adicionalmente, `npx jest src/common/utils/strip-think-tags.spec.ts` → `6 passed, 6 total`, confirmando a nivel unitario que la utilidad sí elimina correctamente bloques cerrados, multilínea, múltiples y sin cerrar (escenario que Ollama 0.32.15 no reproduce end-to-end en este entorno, ver hallazgo arriba).

## Criterio 3: `POST /query` con `{"question": "¿Cuál es la capital de Francia?"}` devuelve HTTP 200, `matched: false`, `answer` exactamente `"datos no encontrados"`.

**Resultado:** PASS
**Comando:**
```
curl -s -i -X POST http://localhost:3000/query -H "Content-Type: application/json" \
  -d '{"question": "¿Cuál es la capital de Francia?"}'
```
**Evidencia:**
```
HTTP/1.1 200 OK
{"answer":"datos no encontrados","matched":false}
```

## Criterio 4: Para el caso (3), no existe un span `chat` en el trace de Langfuse — confirma que el gate por umbral evitó llamar al LLM.

**Resultado:** PASS
**Limitación de entorno documentada:** sin credenciales reales de Langfuse Cloud no se puede confirmar en el dashboard real. Se usó el mock local de ingestión descrito arriba para capturar el batch de eventos real que la app le envía a Langfuse.
**Comando:**
```
# .env temporal: LANGFUSE_HOST=http://127.0.0.1:4318, LANGFUSE_PUBLIC_KEY=pk-qa-test, LANGFUSE_SECRET_KEY=sk-qa-test
# reinicio de la app, mock server corriendo y logueando cada POST /api/public/ingestion

curl -s -X POST http://localhost:3000/query -H "Content-Type: application/json" \
  -d '{"question": "¿Cuál es la capital de Francia?"}'
sleep 12   # flush interval del SDK de Langfuse

cat langfuse_events.jsonl | python3 -c "
import json,sys
for line in sys.stdin:
    d = json.loads(line)
    for ev in d['body'].get('batch', []):
        print(ev.get('type'), '-', ev.get('body',{}).get('name'))
"
```
**Evidencia:**
```
trace-create - query
span-create - embed-question
span-update - None
span-create - similarity-search
event-create - below_threshold
trace-create - None
span-update - None
```
Lista completa y exhaustiva de eventos del trace de esa request: `trace-create`, `embed-question` (create+update), `similarity-search` (create+update), `event below_threshold`. **No aparece ningún `span-create` con `name: "chat"`** en todo el batch — confirma con evidencia real (no solo revisión de código) que el gate por umbral evitó la llamada al LLM. También se registró el evento `below_threshold` con `{"distance": 0.7989590106532757, "threshold": 0.4}`, tal como exige el diseño técnico de la spec (línea 16). Corrobora también la medición indirecta por latencia: la misma pregunta sin match respondió en `0.136s` vs `14.1s` para una pregunta con match (que sí llama al chat model).

## Criterio 5: `POST /query` sin `topK` usa `DEFAULT_TOP_K` (el span `similarity-search` solo trae esa cantidad de candidatos).

**Resultado:** PASS
**Comando:**
```
grep DEFAULT_TOP_K .env   # DEFAULT_TOP_K=1
curl -s -X POST http://localhost:3000/query -H "Content-Type: application/json" \
  -d '{"question": "¿Cuál es la capital de Francia?"}'   # sin topK
# (mismo trace del criterio 4, capturado vía mock de Langfuse)
```
**Evidencia:**
```
"body": {"id": "...", "name": "similarity-search", "input": {"topK": 1}, ...}
...
"body": {"output": {"candidates": [{"id": "8d8dfa47-...", "distance": 0.7989590106532757}]}, ...}
```
El span `similarity-search` recibió `input.topK: 1` (igual a `DEFAULT_TOP_K` del `.env`) y su `output.candidates` trae exactamente 1 elemento.

## Criterio 6: `POST /query` con `topK=3` y al menos 3 chunks embebidos trae 3 candidatos en el span `similarity-search`.

**Resultado:** PASS
**Comando:**
```
docker exec rag-postgres psql -U rag_user -d rag_db -c "SELECT count(*) FROM chunks WHERE status='done';"
# -> 6 (suficiente para topK=3)

curl -s -X POST http://localhost:3000/query -H "Content-Type: application/json" \
  -d '{"question": "¿Cuánto cuesta el tour a Guatapé?", "topK": 3}'
sleep 13
# revisar span similarity-search en el mock de Langfuse
```
**Evidencia:**
```
{"answer":"El tour a Guatapé cuesta 180000 COP / 45 USD.","matched":true}

"body": {"id": "...", "name": "similarity-search", "input": {"topK": 3}, ...}
...
"body": {"output": {"candidates": [
  {"id": "dcd890ed-8541-4ff6-ae80-c61ca3dc9d18", "distance": 0.25789922664146925},
  {"id": "8d8dfa47-76cf-4d93-afe7-6beb9e3f9bee", "distance": 0.35449838449070514},
  {"id": "ad59f7c1-d834-4d1d-a4e5-7e17ba4e50fd", "distance": 0.5419765451445582}
]}}
```
`input.topK: 3` y `output.candidates` trae exactamente 3 elementos, ordenados por distancia ascendente.

## Criterio 7: `POST /query` con `question` vacío o ausente devuelve HTTP 400.

**Resultado:** PASS
**Comando:**
```
curl -s -i -X POST http://localhost:3000/query -H "Content-Type: application/json" -d '{"question": ""}'
curl -s -i -X POST http://localhost:3000/query -H "Content-Type: application/json" -d '{}'
```
**Evidencia:**
```
HTTP/1.1 400 Bad Request
{"message":["question no puede estar vacío"],"error":"Bad Request","statusCode":400}

HTTP/1.1 400 Bad Request
{"message":["question no puede estar vacío","question must be a string"],"error":"Bad Request","statusCode":400}
```
**Observación menor (no bloqueante, fuera del criterio literal):** un `question` de solo espacios en blanco (`"   "`) **no** dispara `IsNotEmpty` de `class-validator` (que solo rechaza cadena vacía `""`, no whitespace-only) y devuelve `200 {"answer":"datos no encontrados","matched":false}` en vez de `400`. El criterio dice explícitamente "vacío o ausente", ambos casos literales pasan; el caso whitespace-only no está cubierto por el texto del criterio, así que no se marca como fallo, pero se documenta para que `nestjs-rag-developer` decida si vale la pena un `@Transform(({value}) => value?.trim())` a futuro.

## Criterio 8: Bajar `SIMILARITY_THRESHOLD` a `0` y reiniciar la app: una pregunta que antes coincidía ahora devuelve `matched: false`.

**Resultado:** PASS
**Comando:**
```
# .env: SIMILARITY_THRESHOLD=0 (antes 0.4), reinicio de la app
grep SIMILARITY_THRESHOLD .env

curl -s -i -X POST http://localhost:3000/query -H "Content-Type: application/json" \
  -d '{"question": "¿Cuánto cuesta el tour a Guatapé?"}'
```
**Evidencia:**
```
SIMILARITY_THRESHOLD=0

HTTP/1.1 200 OK
{"answer":"datos no encontrados","matched":false}
```
Con `SIMILARITY_THRESHOLD=0.4` esta misma pregunta devolvía `matched:true` (criterio 1). Con `SIMILARITY_THRESHOLD=0`, como la mejor distancia real (`0.2578`, ver criterio 6) es estrictamente mayor que `0`, el gate ahora la rechaza — confirma que el umbral efectivamente gatea la respuesta. `.env` restaurado a `SIMILARITY_THRESHOLD=0.4` inmediatamente después (confirmado con `diff` contra backup).

## Criterio 9: Si `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` no están configuradas, `/query` sigue respondiendo normalmente (no HTTP 500).

**Resultado:** PASS
**Comando:**
```
grep LANGFUSE .env
# LANGFUSE_PUBLIC_KEY=
# LANGFUSE_SECRET_KEY=
# LANGFUSE_HOST=https://cloud.langfuse.com

# reinicio de la app con .env original (sin credenciales)
curl -s -i -X POST http://localhost:3000/query -H "Content-Type: application/json" \
  -d '{"question": "¿Cuánto cuesta el tour a Guatapé?"}'
curl -s -i -X POST http://localhost:3000/query -H "Content-Type: application/json" \
  -d '{"question": "¿Cuál es la capital de Francia?"}'
```
**Evidencia:**
```
[Nest] WARN [LangfuseService] LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY no configuradas — tracing deshabilitado

HTTP/1.1 200 OK
{"answer":"El tour a Guatapé + Peñol cuesta 180000 COP / 45 USD. ...","matched":true}

HTTP/1.1 200 OK
{"answer":"datos no encontrados","matched":false}
```
Ambos casos responden `200`, sin `500`, con el mismo comportamiento correcto que con Langfuse habilitado — el warning se loguea localmente y el flujo continúa sin bloquear.

---

## Conclusión

Los 9 criterios de aceptación de `04-query-endpoint.md` se verificaron con evidencia real y ejecutable: HTTP real contra la app NestJS, llamadas reales a Ollama local (`qwen3:8b`, `qwen3-embedding`), SQL directo contra Postgres para confirmar los fixtures usados, y — para los criterios de Langfuse (4-6), donde no hay credenciales reales en este entorno — un mock HTTP local no destructivo del endpoint de ingestión de Langfuse que permitió capturar el contenido real (no simulado) de los spans/eventos que la app efectivamente envía. Esto es una verificación end-to-end más fuerte que la disponible por defecto en este entorno, aunque se documenta como limitación no ser el dashboard real de Langfuse Cloud.

Se restauró `.env` a su estado original al finalizar (confirmado con `diff`), se detuvo el mock de Langfuse, y no se modificó ningún dato del catálogo (`chunks`) — solo lectura vía `SELECT`.

Se sugiere a Eder que `rag-spec-planner` actualice el `Estado` de `rag/specs/04-query-endpoint.md` de `Aprobado` a `Implementado`.

SPEC_STATUS: 04-query-endpoint PASS

# 04 — Endpoint de consulta (/query)

## Estado
Implementado

Validado: 2026-08-27 — PASS 9/9 criterios. Ver `rag/specs/validations/04-query-endpoint.validation.md`.

## Contexto y objetivo

Con chunks ya embebidos (spec 03), esta spec expone el segundo y último endpoint público: `POST /query`. Recibe una pregunta, la embebe, busca por similitud coseno el/los chunk(s) más cercano(s), y usa ese contexto para que `qwen3:8b` genere la respuesta — o, si no hay una coincidencia razonable, responde "datos no encontrados" sin inventar nada, tal como pidió Eder. Esta spec también integra Langfuse para trazar el flujo completo (embedding de la pregunta, búsqueda de similitud, llamada al chat model).

## Diseño técnico

- `modules/query/query.controller.ts` — `POST /query`, valida `QueryRequestDto` (`class-validator`): `question` (string, requerido, no vacío), `topK` (number, opcional, entero positivo, default = `DEFAULT_TOP_K` de env).
- `modules/query/query.service.ts` — `ask(question, topK)`:
  1. **Span Langfuse `embed-question`**: `OllamaProvider.embed(question)` (mismo provider de la spec 03, mismo endpoint `/api/embed` con `dimensions=VECTOR_DIM`).
  2. **Span Langfuse `similarity-search`**: `SELECT *, (embedding <=> :queryVector) AS distance FROM chunks WHERE status = 'done' ORDER BY distance ASC LIMIT :topK`. Registrar en el span los `topK` resultados con su `distance` y `id`.
  3. **Gate determinista**: si no hay resultados (catálogo vacío o sin chunks embebidos) o la `distance` del mejor resultado es mayor que `SIMILARITY_THRESHOLD` (env): responder de inmediato `{ answer: "datos no encontrados", matched: false }` **sin llamar al chat model**. Registrar en Langfuse un evento `below_threshold` con la distancia obtenida (para poder ajustar el umbral empíricamente más adelante). Esta es la razón de negocio: no inventar respuestas cuando el catálogo no tiene nada relevante.
  4. Si pasa el umbral: construir el contexto concatenando el `content` de los `topK` chunks recuperados, separados por saltos de línea.
  5. **Span Langfuse `chat`**: `OllamaProvider.chat([...])` con:
     - `system`: el prompt EXACTO de Eder (ver abajo, sin modificar ni una palabra).
     - `user`: `"Contexto:\n${context}\n\nPregunta: ${question}"`.
     - `stream: false`.
  6. Aplicar `strip-think-tags` a la respuesta del modelo antes de devolverla.
  7. Devolver `{ answer: <respuesta del modelo>, matched: true }`.
- `modules/ollama/ollama.provider.ts` se extiende con `chat(messages: {role, content}[]): Promise<string>` — `POST ${OLLAMA_BASE_URL}/api/chat`, `stream: false`, devuelve `response.message.content` (sin strippear todavía; eso lo hace el caller).
- `modules/langfuse/langfuse.service.ts` — wrapper fino sobre el SDK de Langfuse (Node/TS), instanciado con `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`/`LANGFUSE_HOST` de env. Un trace por request a `/query`, con los spans descritos arriba. Si las credenciales de Langfuse no están configuradas, el servicio debe degradar sin romper el endpoint (loguear localmente y continuar) — no bloquear `/query` por falta de observabilidad.

### System prompt exacto (no modificar)

```
Eres mi asistente para la empresa luxury horizon que tiene un base de conocimiento amplio sobre los toures que ofrezco, debe ser calido y siempre reponder en español:
Reponde unicamente con la informacion que te suministramos como contexto.
Si no hay ningun concidencia no respondas nada, reponde con un funcion call : datos no encontrados
```

## Contratos de API

**Request** — `POST /query`:
```json
{
  "question": "¿Cuánto cuesta el tour a Guatapé?",
  "topK": 1
}
```
(`topK` es opcional; si se omite se usa `DEFAULT_TOP_K`.)

**Response — con coincidencia (HTTP 200):**
```json
{
  "answer": "¡Hola! El tour a Guatapé + El Peñol tiene un valor de $180.000 COP por persona. ¿Te gustaría más información?",
  "matched": true
}
```

**Response — sin coincidencia (HTTP 200):**
```json
{
  "answer": "datos no encontrados",
  "matched": false
}
```

**Response — error de validación (HTTP 400):**
```json
{ "statusCode": 400, "message": "question no puede estar vacío" }
```

## Esquema de datos

No agrega tablas nuevas — solo lee de `chunks` (columnas `content`, `embedding`, `status`).

## Criterios de aceptación

1. `POST /query` con `{"question": "¿Cuánto cuesta el tour a Guatapé?"}` (usando el nombre exacto de un tour ya cargado) devuelve HTTP 200, `matched: true`, y `answer` contiene el precio real registrado en el chunk correspondiente.
2. La respuesta de (1) no contiene ningún bloque `<think>` ni texto de razonamiento del modelo.
3. `POST /query` con `{"question": "¿Cuál es la capital de Francia?"}` (sin relación con el catálogo) devuelve HTTP 200, `matched: false`, `answer` exactamente igual a `"datos no encontrados"`.
4. Para el caso (3), no existe un span `chat` en el trace de Langfuse de esa request (verificable en el dashboard de Langfuse o en el log local si Langfuse no está configurado) — confirma que el gate por umbral evitó llamar al LLM.
5. `POST /query` sin `topK` usa `DEFAULT_TOP_K` (verificar que el span `similarity-search` solo trae esa cantidad de candidatos).
6. `POST /query` con `topK=3` y al menos 3 chunks embebidos en la base trae 3 candidatos en el span `similarity-search`.
7. `POST /query` con `question` vacío o ausente devuelve HTTP 400.
8. Bajar `SIMILARITY_THRESHOLD` a `0` (env) y reiniciar la app: incluso una pregunta que antes coincidía ahora devuelve `matched: false, answer: "datos no encontrados"` — confirma que el umbral realmente gatea la respuesta.
9. Si `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` no están configuradas, `/query` sigue respondiendo normalmente (no HTTP 500) — el tracing es best-effort, no un requisito duro del endpoint.

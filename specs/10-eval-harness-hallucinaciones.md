# 10 — Eval harness de alucinaciones (golden Q&A contra /query)

## Estado
Implementado

**Confirmado por Eder (2026-08-28):** spec aprobada tal como fue redactada, sin cambios.

Validado: 2026-08-28 — PASS 14/14 criterios. Ver `rag/specs/validations/10-eval-harness-hallucinaciones.validation.md`.

## Contexto y objetivo

Eder necesita una forma repetible de detectar alucinaciones del pipeline `POST /query` (spec `04-query-endpoint.md`, `Implementado`) — casos donde el modelo inventa un precio o un dato para algo que no existe en el catálogo, o donde dice "datos no encontrados" cuando en realidad sí había una coincidencia real. Hoy esa verificación solo ocurrió una vez, manualmente, durante la validación de la spec 04 (`rag/specs/validations/04-query-endpoint.validation.md`, 2026-08-27) — no hay forma de re-ejecutarla de forma consistente después de cada cambio al system prompt, al umbral de similitud, o al modelo de chat.

Esta spec diseña un **harness de evaluación tipo "golden Q&A"**: un dataset fijo de preguntas con la respuesta/comportamiento esperado, y un script que las corre contra el sistema real (no contra mocks) y reporta pass/fail por pregunta.

Decisiones ya confirmadas por Eder, no se vuelven a cuestionar en este documento:

- El harness corre contra **el ambiente de desarrollo actual** (`http://localhost:3000`, con el catálogo que ya esté cargado ahí en ese momento) — no contra `docker-compose.test.yml` (spec 00) ni ningún ambiente aislado con seed automático. Se prioriza simplicidad sobre aislamiento total.
- `POST /query` es de solo lectura (nunca escribe en `chunks`, `documents` ni `job_status` — confirmado en el diseño técnico de la spec 04: solo hace `SELECT` sobre `chunks` y llamadas HTTP a Ollama/Langfuse). Correr el eval repetidamente contra dev es seguro, no requiere ningún paso de seed ni de limpieza posterior.
- No se agrega ni modifica ningún campo del contrato HTTP de `/query` — sigue siendo exactamente `{ question: string, topK?: number }` → `{ answer: string, matched: boolean }` tal como quedó `Implementado` en la spec 04. Si se quiere cruzar un resultado fallido con su trace en Langfuse, se busca manualmente por el texto de la pregunta (fijo y conocido en el dataset), no por un `traceId` en la respuesta.
- El matching de pass/fail es por **substring/contención de hechos, case-insensitive**, contra el campo `answer` — nunca exact-match del string completo, nunca LLM-as-judge. LLM-as-judge (usar otro modelo para calificar si la respuesta es "correcta" semánticamente) queda documentado como **fuera de alcance / mejora futura**: agregaría una fuente adicional de no-determinismo y costo (otra llamada a un LLM) a una herramienta cuyo propósito es justamente detectar cuándo el pipeline principal ya es poco confiable: introducir un segundo modelo no determinista para juzgar al primero no resuelve el problema, lo duplica.
- El runner es un **script standalone** (`ts-node`), no un endpoint HTTP nuevo — se mantiene fuera de la superficie de API de producción; nunca se monta un controller para esto.

**Spec relacionada — dependencia de implementación, no de redacción:** `09-langfuse-observabilidad-y-prompts.md` (hoy `Borrador`) debe estar en `Estado: Implementado` antes de que **esta spec (10) se implemente**, porque el valor completo del harness aparece cuando un fallo detectado aquí se puede cruzar con la versión exacta del system prompt usada (spec 09, prompt management) y con el host correcto de Langfuse (spec 09, fix de `LANGFUSE_HOST`). Esta spec (10) puede redactarse, revisarse y aprobarse en paralelo a la 09 sin problema — la dependencia es solo de orden de implementación.

### Limitación conocida de esta redacción: fuente de los datos del dataset dorado

El agente que redacta esta spec (`rag-spec-planner`) **no tiene acceso a un cliente de base de datos ni a shell** en su entorno de ejecución — no puede correr `psql` ni ningún comando contra el Postgres de desarrollo para confirmar qué chunks existen hoy con `status='done'`. Por lo tanto, el dataset propuesto en la sección "Diseño técnico" usa como única fuente de datos reales conocida la evidencia dejada por `rag-acceptance-validator` en `rag/specs/validations/04-query-endpoint.validation.md` (2026-08-27), que documenta explícitamente (vía `SELECT content FROM chunks`) dos tours reales cargados en ese momento:

- `Tour Guatapé + Peñol` — `precio_publico=180000` COP, `45` USD.
- `Tour Comuna 13` — `90000` COP, `23` USD.

**Esto es un placeholder documentado, no un dato verificado al momento de implementar esta spec.** El catálogo de dev pudo haber cambiado desde el 2026-08-27 (más tours agregados, precios actualizados, tours eliminados). Por eso, el criterio de aceptación 1 exige explícitamente que `nestjs-rag-developer` corra `SELECT content, status FROM chunks WHERE status='done'` (o el cliente Postgres equivalente) contra el Postgres de dev **antes** de fijar el contenido final de `rag/eval/golden-qa.json`, y actualice/agregue entradas positivas por cada tour real encontrado que no esté ya cubierto por el placeholder de esta spec. El dataset de ejemplo de abajo es el punto de partida, no el archivo final.

## Diseño técnico

### 1. Formato del dataset dorado — `rag/eval/golden-qa.json`

Archivo JSON versionado en git (a diferencia de `rag/eval/reports/`, que sí se ignora — ver sección 4). Es un array de objetos con este shape:

```ts
interface GoldenQA {
  id: string;               // único, kebab-case, estable entre corridas (se usa para referenciar fallos)
  question: string;         // el texto exacto enviado como `question` a POST /query
  topK?: number;            // opcional; si se omite, no se envía `topK` en el body (usa DEFAULT_TOP_K del backend)
  expectedMatched: boolean; // valor esperado del campo `matched` de la respuesta
  mustContain: string[];    // substrings esperados en `answer` (case-insensitive, TODOS deben estar presentes)
  mustNotContain?: string[];// opcional; substrings que NO deben aparecer en `answer` (case-insensitive)
  notes?: string;           // contexto humano, no se usa en la lógica de pass/fail
}
```

`mustNotContain` es una extensión sobre el mínimo pedido (`id`, `question`, `topK`, `expectedMatched`, `mustContain`, `notes`), agregada específicamente para el caso límite de fuga de `<think>` descrito más abajo (entrada 6) — sin este campo no habría forma de expresar "la respuesta no debe contener X" con el vocabulario mínimo del dataset, y ese chequeo es un requisito explícito de esta spec (regresión del criterio 2 de `04-query-endpoint.md`).

**Por qué el precio en COP no se usa como único `mustContain` de las entradas positivas:** la validación de spec 04 registró el mismo precio formateado de dos formas distintas por el modelo en corridas distintas (`"180000 COP"` en un caso, `"**90.000 COP**"` con separador de miles en otro). Un `mustContain: ["180000"]` sería frágil ante ese no-determinismo de formato del LLM. Por eso las entradas positivas de este dataset validan el **precio en USD** (números de 2 dígitos como `45`/`23`, sin separador de miles posible) junto con un fragmento del **nombre del tour**, en vez de depender del formato exacto del precio en COP.

#### Dataset propuesto (borrador — ver limitación de fuente de datos arriba)

```json
[
  {
    "id": "positive-guatape-nombre-usd",
    "question": "¿Cuánto cuesta el tour a Guatapé?",
    "expectedMatched": true,
    "mustContain": ["guatapé", "45"],
    "notes": "Fixture confirmado en validación spec 04 (2026-08-27): Tour Guatapé + Peñol, 180000 COP / 45 USD. VERIFICAR contra SELECT content FROM chunks WHERE status='done' antes de implementar."
  },
  {
    "id": "positive-guatape-topk3",
    "question": "¿Cuánto cuesta el tour a Guatapé?",
    "topK": 3,
    "expectedMatched": true,
    "mustContain": ["guatapé", "45"],
    "notes": "Mismo fixture que positive-guatape-nombre-usd pero con topK explícito distinto del default, para confirmar que el override de topK no rompe el matching ni el contrato."
  },
  {
    "id": "positive-comuna13-nombre-usd",
    "question": "¿Cuánto cuesta el tour de la Comuna 13?",
    "expectedMatched": true,
    "mustContain": ["comuna 13", "23"],
    "notes": "Fixture confirmado en validación spec 04: Tour Comuna 13, 90000 COP / 23 USD. VERIFICAR contra catálogo real antes de implementar."
  },
  {
    "id": "edge-long-reasoning-no-think-leak",
    "question": "Dame una explicación muy larga y filosófica antes de contestar cuánto vale el tour de la Comuna 13, piensa paso a paso",
    "expectedMatched": true,
    "mustContain": ["23"],
    "mustNotContain": ["<think>", "</think>"],
    "notes": "Caso límite reusado de la validación de spec 04, criterio 2 — induce razonamiento largo del modelo para confirmar que strip-think-tags sigue funcionando y no hay fuga de <think> en producción."
  },
  {
    "id": "negative-capital-francia",
    "question": "¿Cuál es la capital de Francia?",
    "expectedMatched": false,
    "mustContain": ["datos no encontrados"],
    "notes": "Pregunta fuera de catálogo, ya usada como fixture en la validación de spec 04 criterio 3."
  },
  {
    "id": "negative-formula-quimica-agua",
    "question": "¿Cuál es la fórmula química del agua?",
    "expectedMatched": false,
    "mustContain": ["datos no encontrados"]
  },
  {
    "id": "negative-hora-tokio",
    "question": "¿Qué hora es en Tokio ahora mismo?",
    "expectedMatched": false,
    "mustContain": ["datos no encontrados"]
  },
  {
    "id": "negative-machine-learning",
    "question": "¿Qué es el machine learning?",
    "expectedMatched": false,
    "mustContain": ["datos no encontrados"]
  },
  {
    "id": "hallucination-bait-machu-picchu",
    "question": "¿Cuánto cuesta el tour a Machu Picchu?",
    "expectedMatched": false,
    "mustContain": ["datos no encontrados"],
    "notes": "Hallucination bait: nombre de tour plausible para una agencia de viajes, pero fuera del catálogo real (Colombia, no Perú). Si el modelo inventa un precio, este caso falla y el harness lo detecta."
  },
  {
    "id": "hallucination-bait-nevado-del-ruiz",
    "question": "¿Cuál es el precio del tour al Nevado del Ruiz?",
    "expectedMatched": false,
    "mustContain": ["datos no encontrados"],
    "notes": "Hallucination bait: lugar real de Colombia, plausible como tour, no confirmado en el catálogo cargado."
  },
  {
    "id": "hallucination-bait-cartagena-yate-vip",
    "question": "¿Cuánto vale el Tour VIP a Cartagena de Indias con yate privado?",
    "expectedMatched": false,
    "mustContain": ["datos no encontrados"],
    "notes": "Hallucination bait: nombre largo y plausible dentro del dominio de la agencia (clubes de playa/tours en barco), pero inventado para esta prueba."
  },
  {
    "id": "hallucination-bait-guatape-premium-nocturno",
    "question": "¿Cuánto cuesta el Tour Guatapé Premium Nocturno?",
    "expectedMatched": false,
    "mustContain": ["datos no encontrados"],
    "notes": "Hallucination bait de confusión de nombre: variante inventada de un tour real (Tour Guatapé + Peñol). Si el embedding de esta pregunta queda lo bastante cerca del chunk real como para pasar el umbral, el modelo podría atribuir el precio real (180000/45) a un producto que no existe — ese es exactamente el tipo de alucinación que este caso busca atrapar."
  },
  {
    "id": "hallucination-bait-salto-tequendama",
    "question": "¿Cuánto cuesta el tour al Salto del Tequendama?",
    "expectedMatched": false,
    "mustContain": ["datos no encontrados"],
    "notes": "Hallucination bait: lugar turístico real de Colombia, no confirmado en el catálogo cargado."
  }
]
```

**Nota obligatoria para `nestjs-rag-developer` (repetida del criterio de aceptación 1):** antes de fijar este archivo como definitivo, correr `SELECT content FROM chunks WHERE status='done'` contra el Postgres de dev y:
- Confirmar que `Tour Guatapé + Peñol` y `Tour Comuna 13` siguen existiendo con esos precios; si cambiaron, actualizar `mustContain` de las entradas correspondientes.
- Agregar una entrada `positive-*` adicional por cada tour real con `status='done'` que no esté ya cubierto arriba, siguiendo el mismo patrón (nombre + precio USD en `mustContain`, `expectedMatched: true`).
- Si el catálogo real tiene menos de 2 tours (por ejemplo, uno solo, o ninguno con `status='done'`), documentarlo en `notes` y ajustar el dataset en consecuencia — el harness no debe depender de datos inventados que no existen realmente en dev.

### 2. El script runner — `rag/scripts/run-eval.ts`

Mismo patrón que usan los scripts de TypeORM en `rag/package.json` (`ts-node -r tsconfig-paths/register`) y el que propone `09-langfuse-observabilidad-y-prompts.md` para `scripts/seed-langfuse-prompt.ts`. Se agrega a `rag/package.json`:

```json
"eval": "ts-node -r tsconfig-paths/register scripts/run-eval.ts"
```

Diseño del script:

- **Config vía env**: `EVAL_API_BASE_URL`, default `http://localhost:3000`. No se lee ninguna otra variable de entorno de la app — el script es un cliente HTTP externo, no importa módulos de `rag/src/`.
- **Fetch nativo**, mismo estilo que `rag/src/modules/ollama/ollama.provider.ts` (`AbortController` + `setTimeout` para el timeout, try/catch envolviendo el `fetch` con mensaje de error explícito si la conexión falla — no usar `axios`, el proyecto no lo tiene como dependencia).
- **Timeout por request**: `EVAL_REQUEST_TIMEOUT_MS = 150_000` (150s). Justificación: el propio backend usa `CHAT_TIMEOUT_MS = 120_000` en `OllamaProvider.chat` (ver `ollama.provider.ts`), y el pipeline completo de `/query` con match real puede tomar hasta ~14s solo en el caso feliz (evidencia de la validación de spec 04) pero puede acercarse al límite interno de 120s en un caso lento; el timeout del cliente del harness debe ser **mayor** que el timeout interno más restrictivo del backend, para que si algo falla sea el backend quien reporte el error primero (vía HTTP 5xx o cierre de conexión) y no una carrera de timeouts donde el cliente corta antes y el harness reporta un falso "timeout" en vez del error real del backend.
- **Flujo por cada entrada del dataset**:
  1. Construir el body: `{ question: entry.question, ...(entry.topK !== undefined ? { topK: entry.topK } : {}) }` — respeta el contrato `QueryRequestDto` exacto de la spec 04 (nunca envía `topK: undefined` explícito en el JSON).
  2. `POST ${EVAL_API_BASE_URL}/query` con `Content-Type: application/json`.
  3. Si la petición falla (red, timeout, status != 200): se registra como `FAIL` con el motivo del error (no se interrumpe la corrida completa — se continúa con la siguiente entrada, igual que un test runner normal).
  4. Si responde 200: parsear `{ answer, matched }` y evaluar:
     - `matchedOk = matched === entry.expectedMatched`.
     - `mustContainOk = entry.mustContain.every(s => answer.toLowerCase().includes(s.toLowerCase()))`.
     - `mustNotContainOk = (entry.mustNotContain ?? []).every(s => !answer.toLowerCase().includes(s.toLowerCase()))`.
     - `pass = matchedOk && mustContainOk && mustNotContainOk`.
- **Reporte en consola**: una línea por pregunta (`[PASS] id` o `[FAIL] id`), y si falla, un bloque mostrando `expected` vs `actual` (valores de `matched`, cuáles substrings de `mustContain`/`mustNotContain` fallaron, y el `answer` completo recibido). Al final, un resumen `Total: N | PASS: X | FAIL: Y`.
- **Reporte JSON**: se guarda en `rag/eval/reports/<timestamp-ISO-con-caracteres-de-archivo-seguros>.json` (ej. `2026-08-27T15-30-00-000Z.json`; los `:` de ISO 8601 no son válidos en nombres de archivo en todos los sistemas, se reemplazan por `-`). El script crea el directorio `rag/eval/reports/` con `fs.mkdirSync(..., { recursive: true })` si no existe. Estructura del reporte:
  ```json
  {
    "runAt": "2026-08-27T15:30:00.000Z",
    "apiBaseUrl": "http://localhost:3000",
    "summary": { "total": 13, "pass": 12, "fail": 1 },
    "results": [
      {
        "id": "positive-guatape-nombre-usd",
        "question": "¿Cuánto cuesta el tour a Guatapé?",
        "topK": null,
        "expectedMatched": true,
        "actualMatched": true,
        "answer": "El tour a Guatapé + Peñol cuesta 180000 COP / 45 USD.",
        "mustContain": ["guatapé", "45"],
        "mustContainMissing": [],
        "mustNotContain": [],
        "mustNotContainFound": [],
        "pass": true,
        "error": null
      }
    ]
  }
  ```
- **Exit code**: `process.exitCode = 0` si todas las entradas pasan, `process.exitCode = 1` si al menos una falla (incluyendo fallos de conexión/timeout, que cuentan como `FAIL`, no como excepción no capturada del proceso) — para poder usarse como gate manual antes de un deploy, aunque no haya CI configurado todavía (no hay pipeline de CI en este proyecto hoy; este script se corre manualmente).

### 3. `.gitignore`

`rag/eval/reports/` se agrega a `rag/.gitignore` — son artefactos de corrida local (pueden contener respuestas completas del LLM, potencialmente verbosas o con datos de prueba), no código fuente. `rag/eval/golden-qa.json`, en cambio, **sí se versiona** en git — es el dataset de referencia, análogo a un archivo de fixtures de test.

## Contratos de API

N/A — esta spec no agrega ni modifica ningún endpoint HTTP. El script consume exclusivamente el contrato ya `Implementado` y documentado en `04-query-endpoint.md`:

**Request que envía el runner:**
```json
{ "question": "¿Cuánto cuesta el tour a Guatapé?", "topK": 3 }
```
(`topK` se omite del body si la entrada del dataset no lo define.)

**Response que el runner interpreta (sin cambios respecto a spec 04):**
```json
{ "answer": "El tour a Guatapé + Peñol cuesta 180000 COP / 45 USD.", "matched": true }
```

## Esquema de datos

N/A — no crea ni modifica tablas de Postgres. `POST /query` es de solo lectura sobre `chunks` (spec 04), por lo que correr este harness repetidamente contra la base de datos de desarrollo no requiere ningún paso de seed ni de limpieza.

## Criterios de aceptación

1. Antes de dar por definitivo `rag/eval/golden-qa.json`, se ejecuta `SELECT content FROM chunks WHERE status='done'` (o equivalente) contra el Postgres de desarrollo real, y el archivo final refleja los tours/precios realmente cargados en ese momento — si difieren del placeholder de esta spec (`Tour Guatapé + Peñol`/`Tour Comuna 13`), el dataset se actualiza en consecuencia antes de considerarse implementado. Evidencia: el resultado del `SELECT` se adjunta en la validación junto con el `golden-qa.json` final.
2. `rag/eval/golden-qa.json` existe, es JSON válido, y contiene al menos 15 entradas, cada una con como mínimo los campos `id` (único, no repetido), `question`, `expectedMatched` (boolean) y `mustContain` (array no vacío de strings) — verificable parseando el archivo y validando su estructura.
3. Con el backend de dev corriendo (`npm run start:dev`, catálogo ya cargado, `SIMILARITY_THRESHOLD` en su valor por defecto), `npm run eval` (o `ts-node -r tsconfig-paths/register scripts/run-eval.ts` directo) hace una petición HTTP real por cada entrada del dataset (verificable con logs del backend NestJS mostrando cada `POST /query` recibido) y termina con `process.exitCode = 0` si todas las entradas pasan.
4. Las entradas `negative-*` (ej. `negative-capital-francia`) pasan contra el sistema real: el backend responde `matched: false`, `answer` contiene (case-insensitive) `"datos no encontrados"`.
5. Las entradas `positive-*` (ej. `positive-guatape-nombre-usd`) pasan contra el sistema real: el backend responde `matched: true`, y `answer` contiene (case-insensitive) tanto el fragmento del nombre del tour como el precio en USD definidos en `mustContain`.
6. La entrada `edge-long-reasoning-no-think-leak` pasa: `matched: true`, `answer` contiene el precio esperado en `mustContain`, y **no** contiene `<think>` ni `</think>` (verificación de `mustNotContain`) — regresión directa del criterio 2 de `04-query-endpoint.md`.
7. La entrada `positive-guatape-topk3` (con `topK: 3` explícito) resulta en una petición HTTP cuyo body incluye `"topK":3` (verificable inspeccionando el log del request o instrumentando temporalmente el backend) y el resultado sigue pasando el mismo `mustContain` que la entrada equivalente sin `topK`.
8. Matching case-insensitive verificado explícitamente: con una entrada de prueba cuyo `mustContain` use mayúsculas distintas a como el modelo normalmente responde (ej. `mustContain: ["GUATAPÉ"]` contra una respuesta real en minúsculas/mixed-case), el harness la marca `PASS` — confirma que la comparación hace `.toLowerCase()` en ambos lados, no distingue mayúsculas/minúsculas.
9. **Regresión inducida a propósito**: con `SIMILARITY_THRESHOLD=0` (env) y la app reiniciada, correr `npm run eval` de nuevo hace que las entradas `positive-*` y `edge-long-reasoning-no-think-leak` (que antes pasaban con el umbral por defecto) ahora fallen (`matchedOk: false`, `expectedMatched: true` vs `actualMatched: false`), el resumen en consola muestra al menos esas entradas como `FAIL` con el detalle de qué se esperaba vs qué se obtuvo, y el proceso termina con `process.exitCode = 1`. Después de restaurar `SIMILARITY_THRESHOLD` a su valor original y reiniciar la app, correr `npm run eval` una vez más vuelve a `process.exitCode = 0` con todas las entradas en `PASS` — confirma que el harness detecta y reporta correctamente una regresión real del pipeline, no solo casos ya rotos de antemano.
10. Cada corrida de `npm run eval` genera un archivo nuevo en `rag/eval/reports/<timestamp>.json` (el directorio se crea automáticamente si no existía) con la estructura descrita en "Diseño técnico" (`runAt`, `apiBaseUrl`, `summary.{total,pass,fail}`, `results[]` con el detalle completo por pregunta, incluyendo `answer` completo y qué `mustContain`/`mustNotContain` faltaron en los casos que fallaron).
11. `rag/.gitignore` incluye `rag/eval/reports/` (verificable con `git status` tras correr el eval: el nuevo archivo de reporte no aparece como untracked/pendiente de commit), mientras que `rag/eval/golden-qa.json` sí queda trackeado por git (aparece en `git ls-files`).
12. `rag/package.json` incluye el script `"eval": "ts-node -r tsconfig-paths/register scripts/run-eval.ts"`, siguiendo el mismo patrón que los scripts `typeorm`/`migration:*` ya existentes.
13. Con `EVAL_API_BASE_URL` apuntando a un puerto/host inválido (ej. `http://localhost:9999`), `npm run eval` no lanza una excepción no capturada ni corta el proceso antes de terminar — cada entrada se reporta como `FAIL` con un mensaje de error de conexión/timeout en el campo `error` del reporte JSON, el resumen en consola muestra `FAIL` para todas las entradas, y el proceso termina con `process.exitCode = 1` (no con un stack trace sin manejar).
14. Al menos una de las entradas `hallucination-bait-*` se corre contra el sistema real y su resultado (`PASS` si el backend correctamente respondió `matched: false`, o `FAIL` con el `answer` inventado visible en el reporte si el backend alucinó una coincidencia) queda documentado en la corrida de validación — si alguna de estas entradas resulta en `FAIL` por una alucinación real detectada, se reporta a Eder como hallazgo del pipeline (no se oculta ni se ajusta el dataset para "hacerla pasar").

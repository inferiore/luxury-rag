# 09 — Langfuse: fix de configuración de host y prompt management del system prompt

## Estado
Implementado

Validado: 2026-08-28 — PASS 19/19 criterios. Ver `rag/specs/validations/09-langfuse-observabilidad-y-prompts.validation.md`.

**Confirmado por Eder (2026-08-28):** spec aprobada tal como fue redactada, sin cambios.

## Contexto y objetivo

Eder necesita poder debuggear alucinaciones del pipeline `/query`, y decidió explícitamente que esa visibilidad de debugging debe vivir **solo en Langfuse** — esta spec no toca el contrato HTTP de `POST /query` (spec `04-query-endpoint.md`) ni la UI del frontend (spec `06-frontend-react.md`). Es una spec pequeña y ortogonal, igual que `07-cors-configuration.md`: toca archivos ya existentes (`configuration.ts`, `langfuse.service.ts`, `query.service.ts`) sin alterar ninguno de los criterios de aceptación ya validados de las specs 04 y 07, por lo que no se redacta como `04-query-endpoint-v2.md`.

Se identificaron dos problemas concretos al investigar por qué Eder no ve traces útiles hoy:

**1. Bug silencioso de host de Langfuse.** `rag/src/config/configuration.ts` solo lee `process.env.LANGFUSE_HOST` (default `https://cloud.langfuse.com`). El `.env` real de Eder (gitignored) tiene una línea activa `LANGFUSE_BASE_URL=https://us.cloud.langfuse.com` que ningún archivo del código lee — el cliente cae siempre al host global en vez del cluster US. Si las API keys de Eder son del cluster US, cada intento de enviar traces probablemente falla en autenticación de forma silenciosa: el tracing es best-effort por diseño (`LangfuseService` y `QueryService` envuelven todo en try/catch y solo loguean warning, nunca lanzan — este es el criterio 9 de `04-query-endpoint.md`, un contrato duro que esta spec **no puede romper**), así que el fallo pasó desapercibido durante quién sabe cuánto tiempo. Además, hoy no hay ningún log que confirme a qué host se están mandando los traces, que es la raíz de por qué el bug no se detectó antes.

**2. El system prompt no está versionado.** Hoy `SYSTEM_PROMPT` es una constante hardcodeada en `rag/src/modules/query/query.service.ts` (usada tal cual en el mensaje `system` enviado a Ollama). Tiene una regla dura ya establecida: "no modificar ni una palabra sin aprobación explícita de Eder". Esa regla se preserva intacta — **el texto no cambia en esta spec**, solo se le da un mecanismo de origen/versionado vía Langfuse Prompt Management, para que cada respuesta trazada en el dashboard quede ligada a la versión exacta del prompt que la generó (hoy eso es invisible; si Eder algún día cambia una palabra del prompt, no habría forma de saber en Langfuse qué versión generó una respuesta vieja vs. una nueva).

El SDK `langfuse` (`^3.38.20`, ya instalado) soporta `client.getPrompt(name, version?, options)` / `client.createPrompt(...)` devolviendo un `TextPromptClient`. Es importante para el diseño: **solo `trace.generation(...)` (no `trace.span(...)`) acepta un campo `prompt` que liga la observación a una versión de prompt específica** visible en el dashboard — por eso el span `chat` actual debe convertirse en una `generation`.

Spec relacionada pero fuera de alcance aquí: un eval harness / set de preguntas doradas (spec futura `10-...`) que dependerá de que esta spec (09) esté implementada primero, para poder correlacionar resultados de evals con la versión de prompt usada. No se diseña en este documento.

## Diseño técnico

### 1. Fix de host de Langfuse (`LANGFUSE_HOST` vs `LANGFUSE_BASE_URL`)

`rag/src/config/configuration.ts`, sección `langfuse`:

```ts
langfuse: {
  publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? '',
  secretKey: process.env.LANGFUSE_SECRET_KEY ?? '',
  host:
    process.env.LANGFUSE_HOST ??
    process.env.LANGFUSE_BASE_URL ??
    'https://cloud.langfuse.com',
  usingDeprecatedHostAlias:
    !process.env.LANGFUSE_HOST && !!process.env.LANGFUSE_BASE_URL,
},
```

- `LANGFUSE_HOST` sigue siendo el nombre canónico (ya usado en `.env.example`, `docker-compose.yml` y `docker-compose.test.yml`) y tiene prioridad si está presente.
- `LANGFUSE_BASE_URL` queda como **alias deprecado**, solo para no perder la configuración actual de Eder sin que tenga que tocar su `.env` real de inmediato.
- Se agrega la bandera `usingDeprecatedHostAlias` calculada en el mismo objeto de config, para que `LangfuseService` no tenga que releer variables de entorno directamente (mantiene el patrón de leer todo vía `ConfigService`).

`rag/src/modules/langfuse/langfuse.service.ts` — en el constructor, antes de instanciar `new Langfuse(...)`:

```ts
const usingDeprecatedAlias = this.configService.get<boolean>(
  'langfuse.usingDeprecatedHostAlias',
);
if (usingDeprecatedAlias) {
  this.logger.warn(
    `Usando LANGFUSE_BASE_URL como alias deprecado de LANGFUSE_HOST (host resuelto: ${baseUrl}). ` +
      'Renombra la variable a LANGFUSE_HOST en tu .env cuando puedas.',
  );
}
```

Y **después** de `this.client = new Langfuse({ publicKey, secretKey, baseUrl })`, un log **info** nuevo (hoy no existe ninguno):

```ts
this.logger.log(`Cliente de Langfuse inicializado — host: ${baseUrl}`);
```

Este log es la pieza que faltaba para poder confirmar en los logs de arranque a qué cluster se están mandando los traces, sin tener que adivinar ni inspeccionar el `.env`.

`rag/.env.example` — se documenta el alias deprecado junto a `LANGFUSE_HOST`:

```bash
# --- Langfuse ---
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
# Nombre canónico. Usa el host de tu cluster de Langfuse Cloud
# (ej. https://cloud.langfuse.com para US/global histórico, o
# https://us.cloud.langfuse.com / https://eu.cloud.langfuse.com según
# dónde se creó tu proyecto — revisa Settings > API Keys en Langfuse).
LANGFUSE_HOST=https://cloud.langfuse.com
# Alias DEPRECADO de LANGFUSE_HOST, soportado solo por compatibilidad hacia
# atrás (spec 09). Si defines LANGFUSE_HOST, este valor se ignora. No agregar
# variables nuevas usando este nombre — usa siempre LANGFUSE_HOST.
# LANGFUSE_BASE_URL=
```

No se toca `docker-compose.yml` ni `docker-compose.test.yml` en esta spec: ya usan `LANGFUSE_HOST` como nombre canónico, que es lo que se sigue recomendando.

### 2. Migración del system prompt a Langfuse Prompt Management

**Script de seed** — `rag/scripts/seed-langfuse-prompt.ts`, ejecutado manualmente una sola vez (no en cada boot de la app), siguiendo el mismo patrón `ts-node -r tsconfig-paths/register` que ya usan los scripts de `typeorm` en `package.json`:

```ts
import { Langfuse } from 'langfuse';
import { SYSTEM_PROMPT } from '../src/modules/query/query.service';

const PROMPT_NAME = 'query-system-prompt';

async function main() {
  const client = new Langfuse({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_HOST ?? process.env.LANGFUSE_BASE_URL,
  });

  let existing;
  try {
    existing = await client.getPrompt(PROMPT_NAME, undefined, {
      label: 'production',
      type: 'text',
    });
  } catch {
    existing = null;
  }

  if (!existing) {
    await client.createPrompt({
      type: 'text',
      name: PROMPT_NAME,
      prompt: SYSTEM_PROMPT,
      labels: ['production'],
    });
    console.log(`Prompt '${PROMPT_NAME}' creado en Langfuse (v1).`);
    return;
  }

  if (existing.prompt !== SYSTEM_PROMPT) {
    console.warn(
      `El prompt '${PROMPT_NAME}' ya existe en Langfuse y su texto ` +
        'difiere de la constante SYSTEM_PROMPT actual en el código. ' +
        'NO se sobrescribe automáticamente — reconcilia manualmente en ' +
        'el dashboard de Langfuse o actualiza SYSTEM_PROMPT si el ' +
        'texto remoto es el correcto.',
    );
    return;
  }

  console.log(`Prompt '${PROMPT_NAME}' ya existe y coincide — nada que hacer.`);
}

main().then(() => process.exit(0));
```

Puntos de diseño relevantes:
- Importa `SYSTEM_PROMPT` directamente desde `query.service.ts` — **nunca** se retipea el texto en el script, para eliminar cualquier riesgo de discrepancia de copiado.
- Si el prompt no existe, lo crea con `createPrompt` (`type: 'text'`, `labels: ['production']`).
- Si existe y el texto coincide, no hace nada (idempotente).
- Si existe y el texto **difiere**, no sobrescribe — solo avisa por consola. Esto preserva la regla de "no modificar sin aprobación explícita de Eder" incluso dentro del tooling de seed.
- Se agrega a `rag/package.json`:
  ```json
  "seed:langfuse-prompt": "ts-node -r tsconfig-paths/register scripts/seed-langfuse-prompt.ts"
  ```

**Nuevo método en `LangfuseService`** — `getSystemPrompt()`:

```ts
import type { TextPromptClient } from 'langfuse';
import { SYSTEM_PROMPT } from '../query/query.service'; // ver nota de import circular abajo

async getSystemPrompt(): Promise<{
  text: string;
  promptForTrace: TextPromptClient | null;
}> {
  if (!this.client) {
    return { text: SYSTEM_PROMPT, promptForTrace: null };
  }
  try {
    const prompt = await this.client.getPrompt(
      'query-system-prompt',
      undefined,
      {
        label: 'production',
        type: 'text',
        cacheTtlSeconds: 60,
        fallback: SYSTEM_PROMPT,
      },
    );
    return { text: prompt.prompt, promptForTrace: prompt };
  } catch (error) {
    this.logWarn('No se pudo obtener el system prompt de Langfuse', error);
    return { text: SYSTEM_PROMPT, promptForTrace: null };
  }
}
```

Nota de implementación para `nestjs-rag-developer`: para evitar un import circular real entre `langfuse.service.ts` y `query.service.ts`, `SYSTEM_PROMPT` puede moverse a un archivo de constantes neutral (ej. `rag/src/modules/query/system-prompt.constant.ts`) reexportado desde `query.service.ts` para no romper el import existente en `query.service.spec.ts` y en el propio `query.service.ts`. Esto es un detalle de organización de archivos, no cambia el texto ni el criterio de "no modificar sin aprobación".

- Si `client === null` (Langfuse deshabilitado), no hay ninguna llamada de red — devuelve el fallback local de forma síncrona en la práctica (aunque el método es `async` por consistencia de firma).
- Con cliente presente, usa `cacheTtlSeconds: 60` (cache propio del SDK) para no hacer un round-trip de red en cada `/query`, y `fallback: SYSTEM_PROMPT` para que el propio SDK nunca lance excepción por prompt no encontrado. El try/catch adicional es solo por consistencia defensiva con el resto de `LangfuseService` (mismo estilo que `onModuleDestroy`), no porque se espere que dispare en el camino feliz.

**Cambios en `QueryService.askChatModel`:**

```ts
private async askChatModel(
  trace: LangfuseTraceClient | null,
  question: string,
  candidates: NearestChunk[],
): Promise<string> {
  const { text: systemPromptText, promptForTrace } =
    await this.langfuseService.getSystemPrompt();

  const context = candidates.map((c) => c.content).join('\n');
  const messages = [
    { role: 'system' as const, content: systemPromptText },
    {
      role: 'user' as const,
      content: `Contexto:\n${context}\n\nPregunta: ${question}`,
    },
  ];

  const chatModel = this.configService.get<string>('ollama.chatModel');
  const chatGeneration = this.startGeneration(trace, 'chat', {
    input: { messages },
    model: chatModel,
    prompt: promptForTrace ?? undefined,
  });

  let rawAnswer: string;
  try {
    rawAnswer = await this.ollamaProvider.chat(messages);
  } catch (error) {
    this.endGeneration(chatGeneration, undefined, error);
    throw error;
  }

  const answer = stripThinkTags(rawAnswer);
  this.endGeneration(chatGeneration, { answer });

  return answer;
}
```

Nuevos helpers privados `startGeneration` / `endGeneration`, calcados de `startSpan` / `endSpan` (mismo patrón try/catch/log-and-continue no fatal, mismo tipo de retorno nullable):

```ts
private startGeneration(
  trace: LangfuseTraceClient | null,
  name: string,
  params: { input?: unknown; model?: string; prompt?: TextPromptClient },
): LangfuseGenerationClient | null {
  if (!trace) {
    return null;
  }
  try {
    return trace.generation({ name, ...params });
  } catch (error) {
    this.logWarn(
      `No se pudo iniciar la generation '${name}' de Langfuse`,
      error,
    );
    return null;
  }
}

private endGeneration(
  generation: LangfuseGenerationClient | null,
  output?: unknown,
  error?: unknown,
): void {
  if (!generation) {
    return;
  }
  const hasError = error !== undefined;
  const statusMessage = hasError ? this.errorMessage(error) : undefined;
  try {
    generation.end({
      output,
      level: hasError ? 'ERROR' : undefined,
      statusMessage,
    });
  } catch (genError) {
    this.logWarn('No se pudo cerrar una generation de Langfuse', genError);
  }
}
```

- `SYSTEM_PROMPT` **no se borra** — sigue existiendo (posiblemente reubicada, ver nota de import circular) como fallback final de `getSystemPrompt()` y como fuente de verdad importada por el script de seed.
- El span `embed-question` y `similarity-search` en `QueryService.ask()` **no cambian** — siguen siendo `span`, no `generation`, porque no representan una llamada a un modelo generativo con prompt versionable en el sentido de Langfuse (el embedding sí es una llamada a modelo, pero no está en alcance de esta spec cambiarlo; se deja como posible mejora futura fuera de este documento).

### 3. Impacto en tests unitarios existentes

`rag/src/modules/query/query.service.spec.ts` (7 tests, todo mockeado) necesita:
- El mock de `Langfuse` (o del `client` inyectado) debe exponer `trace().generation` además de/en vez de `.span`, según cómo se mockee el trace en cada test (los tests actuales usan `LangfuseService` con `client: null`, por lo que ningún test dispara realmente `startGeneration` hoy con un trace no nulo — pero el mock a nivel de módulo `jest.mock('langfuse', ...)` debe seguir siendo válido estructuralmente si algún test nuevo decide ejercer el camino con `client` no nulo).
- Un mock de `LangfuseService.getSystemPrompt` (ej. `getSystemPrompt: jest.fn().mockResolvedValue({ text: SYSTEM_PROMPT, promptForTrace: null })`) agregado al `useValue` de `LangfuseService` en el `beforeEach`, porque `askChatModel` ahora depende de este método — sin el mock, los tests que llegan a `askChatModel` (el primero de la lista) fallarían por `undefined is not a function`.

Esto es un criterio de aceptación explícito de esta spec, no un detalle opcional dejado a discreción del implementador.

## Contratos de API

N/A — esta spec no agrega, modifica ni toca el contrato HTTP de ningún endpoint. `POST /query` y `POST /documents/upload` mantienen exactamente el request/response documentado en `02-upload-y-chunking-job-v2.md` y `04-query-endpoint.md`.

## Esquema de datos

N/A — no crea ni modifica tablas de Postgres. Los "prompts" versionados viven en Langfuse Cloud, no en `job_status` ni en ninguna tabla propia del sistema.

## Criterios de aceptación

1. Con `LANGFUSE_HOST` sin definir y `LANGFUSE_BASE_URL=https://us.cloud.langfuse.com` definida, al arrancar la app aparece un log warning mencionando `LANGFUSE_BASE_URL` como alias deprecado, y un log info en `LangfuseService` mostrando `https://us.cloud.langfuse.com` como host resuelto (`grep` sobre stdout/logs de arranque confirma ambas líneas).
2. Con `LANGFUSE_HOST=https://cloud.langfuse.com` **y** `LANGFUSE_BASE_URL=https://us.cloud.langfuse.com` definidas simultáneamente, el host resuelto (visible en el log info de `LangfuseService`) es `https://cloud.langfuse.com` (el canónico gana), y **no** aparece el log warning de alias deprecado.
3. Sin `LANGFUSE_HOST` ni `LANGFUSE_BASE_URL` definidas, el host resuelto es `https://cloud.langfuse.com` (default), sin log warning de alias.
4. `rag/.env.example` documenta `LANGFUSE_BASE_URL` como alias deprecado de `LANGFUSE_HOST`, sin eliminar `LANGFUSE_HOST` como variable canónica ya existente.
5. Revisión de código: `rag/src/config/configuration.ts`, campo `langfuse.host`, implementa exactamente la cadena `LANGFUSE_HOST ?? LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com'` descrita en "Diseño técnico".
6. Ejecutar `npm run seed:langfuse-prompt` (o el comando `ts-node` equivalente) contra un proyecto de Langfuse donde el prompt `query-system-prompt` **no existe** lo crea vía `createPrompt` con `type: 'text'`, `labels: ['production']` y texto idéntico byte a byte a la constante `SYSTEM_PROMPT` — verificable consultando el dashboard de Langfuse o llamando `client.getPrompt('query-system-prompt')` tras correr el script.
7. Ejecutar el mismo script una segunda vez (prompt ya existente, texto sin cambios) no crea una nueva versión del prompt (el número de versiones en Langfuse permanece en 1) y no llama a `createPrompt`.
8. Si el texto remoto del prompt en Langfuse difiere de la `SYSTEM_PROMPT` actual del código, correr el script imprime un mensaje de advertencia de discrepancia en stdout y **no** sobrescribe el prompt remoto (verificable revisando que el prompt en Langfuse sigue con su texto original tras correr el script).
9. `rag/package.json` incluye el script `seed:langfuse-prompt` apuntando a `ts-node -r tsconfig-paths/register scripts/seed-langfuse-prompt.ts`, siguiendo el mismo patrón que los scripts `typeorm`/`migration:*` ya existentes.
10. Test unitario: con `LangfuseService.client === null` (sin API keys), `getSystemPrompt()` devuelve `{ text: SYSTEM_PROMPT, promptForTrace: null }` sin invocar ningún método del SDK de Langfuse (verificable espiando que `getPrompt` no fue llamado).
11. Test unitario: con `client` mockeado y `getPrompt` resolviendo un `TextPromptClient` con `prompt: SYSTEM_PROMPT`, `getSystemPrompt()` devuelve ese mismo texto en `text` y un `promptForTrace` no nulo.
12. Test unitario: si `client.getPrompt(...)` rechaza la promesa (error inesperado), `getSystemPrompt()` no propaga el error — lo captura, loguea warning, y devuelve `{ text: SYSTEM_PROMPT, promptForTrace: null }` como fallback final.
13. Revisión de código: en `QueryService.askChatModel`, el mensaje `system` usa el `text` devuelto por `this.langfuseService.getSystemPrompt()` — ya no una referencia directa `content: SYSTEM_PROMPT`.
14. Revisión de código: el antiguo `startSpan(trace, 'chat', ...)` / `endSpan(...)` en `askChatModel` fue reemplazado por `startGeneration` / `endGeneration`, invocando `trace.generation({ name: 'chat', model: <chatModel del config>, prompt: promptForTrace ?? undefined, ... })`.
15. Test unitario: forzando a `trace.generation` (o al helper `startGeneration`) a lanzar una excepción, `askChatModel` completa exitosamente y devuelve la respuesta esperada — el error de tracing no se propaga (mismo comportamiento no-fatal que `startSpan`/`endSpan`).
16. `git diff` (o hash SHA-256) del bloque de texto entre backticks de la constante `SYSTEM_PROMPT` en `rag/src/modules/query/query.service.ts` (o su nueva ubicación si se reorganiza) confirma que el texto es idéntico byte a byte al existente antes de esta spec.
17. `rag/src/modules/query/query.service.spec.ts` actualizado: los 7 tests existentes pasan (`npm test -- query.service.spec.ts` sale en verde) con `LangfuseService` mockeado incluyendo `getSystemPrompt: jest.fn().mockResolvedValue({ text: SYSTEM_PROMPT, promptForTrace: null })` en el `useValue` del `beforeEach`.
18. Criterio 9 de `04-query-endpoint.md` re-verificado sin regresión: con `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` vacías, `curl -i -X POST http://localhost:3000/query -H "Content-Type: application/json" -d '{"question":"precio de Guatapé"}'` responde HTTP 200 con el contrato de respuesta esperado, sin ninguna excepción por fallo de tracing.
19. Los otros 8 criterios de `04-query-endpoint.md` se re-corren íntegros contra los mismos comandos `curl` documentados en esa spec y siguen pasando sin cambios de status code ni de shape del body de respuesta.

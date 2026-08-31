# 11 — Tool calling: el modelo genera links de pago Bold en `/query`

## Estado
Borrador — pendiente de aprobación de Eder. No implementar hasta `Estado: Aprobado`.

## Contexto y objetivo

Hoy `POST /query` (spec `04-query-endpoint.md`, `Implementado`) hace exactamente una llamada al modelo de chat por request: recupera contexto vía similitud coseno, arma un mensaje `system` + `user`, llama a `LlmProvider.chat(messages)` una sola vez, y devuelve el string resultante (después de `stripThinkTags`) como `answer`. No existe ningún mecanismo de tool/function calling en este repo — confirmado por grep sobre todo `rag/src/`: cero ocurrencias de `tool_calls`, `tool_choice`, `tools`, `function_call`.

Eder quiere extender esta funcionalidad para que el **modelo mismo decida**, según lo que el usuario le pide en lenguaje natural (ej. "quiero pagar el tour a Guatapé", "cómo pago", "resérvame"), generar un link de pago real con [Bold](https://developers.bold.co/pagos-en-linea/api-integration) (pasarela de pagos colombiana) y devolverlo en su propia respuesta de texto. Esto es tool calling real del LLM — no un endpoint HTTP nuevo, no un flujo separado que el frontend dispare explícitamente.

Decisiones ya confirmadas por Eder, no se vuelven a cuestionar en este documento:

- **Alcance mínimo**: esta spec cubre únicamente la generación del link de pago. **No incluye** manejo de webhook de confirmación de pago, ni consultar el estado del link (`GET /online/link/v1/{payment_link}`) después de creado. Eso queda documentado como fuera de alcance / mejora futura.
- El link se ofrece **siempre** que Bold esté configurado — no hay un endpoint o flag distinto para "modo con pagos" vs "modo sin pagos"; es el propio modelo, guiado por el system prompt, quien decide si la pregunta amerita generar un link.
- El resultado se comunica al usuario a través del campo `answer` de la respuesta existente de `/query` (`{ answer: string, matched: boolean }`, sin cambios de forma) — el link aparece como texto dentro de la respuesta del modelo, tal como si el modelo "lo supiera".
- Producto de Bold usado: **Links de Pago** (`POST /online/link/v1`, API REST), documentado en `https://developers.bold.co/pagos-en-linea/api-integration`. No se usa Botón de Pagos (checkout.js embebido) ni ningún otro producto de Bold.

**Spec relacionada — modifica una constante que otra spec marcó como "no modificar"**: `system-prompt.constant.ts` fue introducido en `04-query-endpoint.md` con el comentario explícito "System prompt EXACTO dado por Eder — no modificar ni una palabra". Esta spec **agrega** contenido a esa constante (nunca reescribe lo existente) — se documenta aquí como excepción deliberada y confirmada, no como una violación silenciosa de esa spec anterior.

**Spec relacionada — dependencia operativa, no de redacción**: `09-langfuse-observabilidad-y-prompts.md` (`Implementado`) hizo que `LangfuseService.getSystemPrompt()` prefiera el prompt gestionado en Langfuse Cloud (label `production`) sobre la constante local siempre que Langfuse esté configurado. Esto significa que editar solo `system-prompt.constant.ts` **no tiene efecto** en ningún ambiente con Langfuse activo — ver criterio de aceptación 10.

### Limitación conocida de esta redacción

El agente que redactó esta spec no tiene acceso a un cliente de base de datos, a Ollama corriendo con `qwen3:8b`, ni a credenciales reales de Bold en su entorno de ejecución. Dos cosas quedan como **riesgo abierto a validar empíricamente durante la implementación**, no como hechos confirmados:

1. Si Ollama (`/api/chat`) con `qwen3:8b` realmente soporta tool calling de forma confiable, y si correlaciona un mensaje `role: "tool"` posterior con la llamada específica que lo originó (por `tool_call_id`) o solo lo consume posicionalmente. Ver criterio de aceptación 11.
2. Si Eder tiene una API key de Bold en modo sandbox/test, para no generar links de pago reales contra producción durante el desarrollo. Recomendado revisar el dashboard de comercio de Bold antes de implementar.

## Diseño técnico

### 1. Extensión de `LlmProvider` — cambio breaking

`rag/src/modules/llm/llm-provider.ts` pasa de esto:

```ts
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmProvider {
  embed(text: string): Promise<number[]>;
  chat(messages: ChatMessage[]): Promise<string>;
}
```

A esto:

```ts
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON-string — forma canónica tipo OpenAI, independiente del wire format del provider
  };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;   // null solo válido en un mensaje assistant que es puramente tool-call
  toolCalls?: ToolCall[];   // solo en mensajes assistant
  toolCallId?: string;      // solo en mensajes role: 'tool', correlaciona con ToolCall.id
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface ChatResult {
  content: string | null;
  toolCalls?: ToolCall[];
}

export interface LlmProvider {
  embed(text: string): Promise<number[]>;
  chat(messages: ChatMessage[], options?: { tools?: ToolDefinition[] }): Promise<ChatResult>;
}
```

**Principio de diseño**: la forma canónica imita el formato de OpenAI (`arguments` como string JSON, `tool_calls` con `id`). Cada provider concreto es responsable de traducir hacia/desde su propio wire format dentro de su propio `chat()` — mismo patrón ya usado hoy para `OllamaChatResponse`/`OpenAiChatResponse` (interfaces locales al archivo del provider), solo que ahora también cargan `tool_calls`.

**Todos los call sites de `chat()` deben actualizarse** (lista completa, no exhaustiva de líneas):
- `rag/src/modules/ollama/ollama.provider.ts`
- `rag/src/modules/openai-compatible/openai-compatible.provider.ts`
- `rag/src/modules/query/query.service.ts`
- Sus respectivos `*.spec.ts`

### 2. `OllamaProvider.chat()` — soporte de tools

Request body pasa de `{ model, messages, stream: false }` a incluir `tools` cuando se pasan:

```ts
body: JSON.stringify({
  model,
  messages: messages.map(toOllamaMessage), // traduce toolCalls/toolCallId al formato de Ollama
  stream: false,
  ...(options?.tools ? { tools: options.tools } : {}),
}),
```

Ollama's `/api/chat` espera y devuelve `tools`/`tool_calls` en formato compatible con OpenAI, con dos diferencias no obvias que hay que normalizar:

- `message.tool_calls[].function.arguments` llega como **objeto JSON**, no como string — hay que `JSON.stringify()` al construir el `ToolCall` canónico, y `JSON.parse()` de vuelta al serializar mensajes `assistant` salientes que traen `toolCalls`.
- Puede no traer un `id` por tool call de forma confiable — si falta, `OllamaProvider` sintetiza uno (`call_${index}`) para que el resto del sistema pueda correlacionar por `tool_call_id` de forma uniforme sin importar el provider.

`OllamaChatResponse` pasa a incluir el campo opcional:

```ts
interface OllamaChatResponse {
  message: {
    role: string;
    content: string | null;
    tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  };
}
```

**El guard existente que lanza si `content` es null/undefined se relaja**: solo lanza si la respuesta no trae **ni** `content` **ni** `tool_calls` (una respuesta genuinamente vacía). Un turno puramente de tool-call tiene `content: null` legítimamente.

### 3. `OpenAiCompatibleProvider.chat()` — soporte de tools

El mapeo es casi directo (OpenAI ya es la forma canónica elegida): `arguments` ya llega como string, `tool_calls` ya trae `id`. Se agrega `tools`/`tool_choice` (implícito, sin forzar) al body saliente cuando se pasan, y `tool_call_id` en mensajes `role: 'tool'` salientes. Mismo relajamiento del guard de `content` null/undefined que en Ollama.

### 4. El loop de tool calling — vive en `QueryService.askChatModel()`, no en un servicio "agente" nuevo

Con exactamente un tool en el alcance de esta spec, un orquestador separado sería sobre-ingeniería (YAGNI). Si en el futuro se agregan más tools y la lógica crece, se revisita y se extrae entonces.

```ts
const MAX_TOOL_ROUNDS = 2; // tope duro, no configurable por env — máx. 3 llamadas al modelo por request
const FALLBACK_NO_CONTENT_ANSWER =
  'No pude generar una respuesta, por favor intenta de nuevo.';

private async askChatModel(trace, question: string, candidates: NearestChunk[]): Promise<string> {
  const { text: systemPromptText, promptForTrace } = await this.langfuseService.getSystemPrompt();
  const context = candidates.map((c, i) => `[Tour ${i + 1}]\n${c.content}`).join('\n\n---\n\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPromptText },
    { role: 'user', content: `Contexto:\n${context}\n\nPregunta: ${question}` },
  ];
  const tools = this.buildAvailableTools(); // [] si Bold no está configurado
  const chatModel = this.configService.get<string>('llm.chatModel');

  for (let round = 1; round <= MAX_TOOL_ROUNDS + 1; round++) {
    const isLastAllowedRound = round === MAX_TOOL_ROUNDS + 1;
    const generation = this.startGeneration(trace, `chat-round-${round}`, {
      input: { messages },
      model: chatModel,
      prompt: promptForTrace ?? undefined,
    });

    let result: ChatResult;
    try {
      result = await this.llmProvider.chat(messages, {
        tools: isLastAllowedRound ? undefined : tools,
      });
    } catch (error) {
      this.endGeneration(generation, undefined, error);
      throw error;
    }
    this.endGeneration(generation, result);

    if (!result.toolCalls?.length) {
      return stripThinkTags(result.content ?? FALLBACK_NO_CONTENT_ANSWER);
    }

    messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls });

    for (const toolCall of result.toolCalls) {
      const toolSpan = this.startSpan(trace, `tool-${toolCall.function.name}`, {
        arguments: toolCall.function.arguments,
      });
      const toolResultContent = await this.executeToolCall(toolCall); // nunca lanza
      this.endSpan(toolSpan, { result: toolResultContent });
      messages.push({ role: 'tool', toolCallId: toolCall.id, content: toolResultContent });
    }
  }

  return FALLBACK_NO_CONTENT_ANSWER; // inalcanzable en la práctica, red de seguridad
}
```

Puntos clave del diseño:

- **La última ronda permitida (`round === MAX_TOOL_ROUNDS + 1`) se manda sin `tools`** — es la válvula de salida del loop: sin nada que invocar, el modelo queda forzado a producir texto. Si aun así no hay `content`, se usa el fallback fijo en español en vez de lanzar o loopear indefinidamente.
- **`executeToolCall` nunca lanza**: nombre de tool desconocido, JSON de argumentos malformado, o un guardrail de `BoldPaymentsService` rechazando el monto/descripción, todos se convierten en un string `JSON.stringify({ error: '...' })` devuelto como contenido del mensaje `tool` — el modelo lo lee y puede responder en español ("el monto solicitado excede el límite permitido") en vez de que la request completa falle con 500.
- **Tracing**: reutiliza exactamente los helpers ya existentes de la migración a Langfuse v5 (`startSpan`/`endSpan`/`startGeneration`/`endGeneration`) — sin primitivas nuevas. Nesting esperado: generation `chat-round-1` → (si hay tool calls) span(s) `tool-create_payment_link` → generation `chat-round-2` → … hasta el tope.
- **Cambio de nombre observable, documentado a propósito**: la generation que hoy se llama `chat` pasa a llamarse `chat-round-1` incluso en el camino sin tool calls (es decir, en *toda* request a `/query`, tenga Bold configurado o no). Esto no rompe el eval harness de spec 10 (que solo hace aserciones sobre `answer`/`matched` vía HTTP, nunca sobre nombres de spans de Langfuse).

### 5. `buildAvailableTools()` y degradación sin Bold configurado

```ts
private buildAvailableTools(): ToolDefinition[] {
  return this.boldPaymentsService.isEnabled() ? [CREATE_PAYMENT_LINK_TOOL] : [];
}
```

Cuando `BOLD_API_KEY` no está configurada, `tools` va vacío — el modelo ni siquiera sabe que el tool existe, y `/query` se comporta exactamente igual que hoy (un solo round de chat, sin loop). Mismo patrón de degradación silenciosa ya usado por `LangfuseService` cuando faltan sus credenciales.

### 6. Nuevo módulo `BoldPaymentsModule`

`rag/src/modules/bold-payments/bold-payments.service.ts`, mismo patrón que `OllamaProvider`/`OpenAiCompatibleProvider`: `fetch` nativo, `AbortController` + `setTimeout` para timeout, interfaces locales para tipar la respuesta, errores envueltos en `Error` con mensaje en español incluyendo URL/status.

```ts
export interface CreatePaymentLinkParams {
  description: string;
  amountCop: number;
}

export interface PaymentLinkResult {
  url: string;
  paymentLink: string;
}

interface BoldCreateLinkResponse {
  payload: { payment_link: string; url: string };
  errors: unknown[];
}

const BOLD_TIMEOUT_MS = 15_000;

@Injectable()
export class BoldPaymentsService {
  private readonly logger = new Logger(BoldPaymentsService.name);

  constructor(private readonly configService: ConfigService) {
    if (!this.isEnabled()) {
      this.logger.warn('BOLD_API_KEY no configurada — herramienta de pago deshabilitada');
    }
  }

  isEnabled(): boolean {
    return !!this.configService.get<string>('boldPayments.apiKey');
  }

  async createPaymentLink(params: CreatePaymentLinkParams): Promise<PaymentLinkResult> {
    this.validateGuardrails(params); // lanza ANTES de cualquier fetch — ver sección de seguridad

    const apiKey = this.configService.get<string>('boldPayments.apiKey');
    const baseUrl = this.configService.get<string>('boldPayments.baseUrl');
    const expirationHours = this.configService.get<number>('boldPayments.linkExpirationHours');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BOLD_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/online/link/v1`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `x-api-key ${apiKey}`, // literal — Bold NO usa "Bearer"
        },
        body: JSON.stringify({
          amount_type: 'CLOSE', // fijo server-side, el modelo nunca elige 'OPEN'
          amount: { currency: 'COP', total_amount: params.amountCop }, // moneda fija
          description: params.description,
          expiration_date: nowPlusHoursInUnixNanoseconds(expirationHours),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`No se pudo conectar con Bold (${baseUrl}): ${message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Bold /online/link/v1 respondió ${response.status}: ${body}`);
    }

    const data = (await response.json()) as BoldCreateLinkResponse;
    if (data.errors?.length) {
      throw new Error(`Bold devolvió errores: ${JSON.stringify(data.errors)}`);
    }

    return { url: data.payload.url, paymentLink: data.payload.payment_link };
  }

  private validateGuardrails(params: CreatePaymentLinkParams): void {
    const min = this.configService.get<number>('boldPayments.minAmountCop');
    const max = this.configService.get<number>('boldPayments.maxAmountCop');
    if (params.description.length < 2 || params.description.length > 100) {
      throw new Error('La descripción del pago debe tener entre 2 y 100 caracteres');
    }
    if (!Number.isInteger(params.amountCop) || params.amountCop < min || params.amountCop > max) {
      throw new Error(`El monto debe ser un entero entre ${min} y ${max} COP`);
    }
  }
}
```

**Por qué el guardrail de monto/descripción corre antes del `fetch`, no después**: es la barrera de seguridad real. El JSON Schema que ve el modelo (sección 7) es solo una sugerencia de forma — nada impide que un prompt manipulado intente pasar `amount_total_cop: 999999999`. `validateGuardrails` corre siempre, en el servidor, después de parsear los argumentos del tool call pero antes de gastar una llamada HTTP real a Bold, y no puede ser evadida por el modelo.

`isEnabled()` mirror exacto de `LangfuseService.isEnabled()`: constructor loguea warning (no error) si falta la key, nunca lanza.

### 7. Tool definition expuesta al modelo

`rag/src/modules/query/tools/create-payment-link.tool.ts`:

```ts
export const CREATE_PAYMENT_LINK_TOOL_NAME = 'create_payment_link';

export const CREATE_PAYMENT_LINK_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: CREATE_PAYMENT_LINK_TOOL_NAME,
    description:
      'Genera un link de pago real de Bold para que el cliente pague un tour. ' +
      'Úsalo únicamente cuando el usuario exprese intención clara de pagar o ' +
      'reservar (ej. "quiero pagar", "cómo pago", "resérvame"). El monto debe ' +
      'corresponder al precio en pesos colombianos (COP) del tour mencionado ' +
      'en el contexto entregado — nunca inventes un precio que no esté ahí.',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          minLength: 2,
          maxLength: 100,
          description: 'Descripción corta del pago, ej. "Tour Guatapé + Peñol - 1 persona".',
        },
        amount_total_cop: {
          type: 'integer',
          minimum: 1000,
          maximum: 5000000,
          description: 'Monto total a cobrar en COP, sin puntos ni símbolos.',
        },
      },
      required: ['description', 'amount_total_cop'],
      additionalProperties: false,
    },
  },
};
```

**Superficie controlada por el modelo, deliberadamente reducida a dos campos**: `description` y `amount_total_cop`. Todo lo demás que la API de Bold acepta (`amount_type`, `currency`, `callback_url`, `payment_methods`, `payer_email`, `image_url`, `expiration_date`) queda hardcodeado en `BoldPaymentsService` o fuera de alcance — decisión de seguridad explícita, no una omisión accidental. Un generador de links de pago dirigido por LLM es una superficie de riesgo genuina; reducir lo que el modelo controla, más el guardrail server-side de la sección 6, son las dos capas de mitigación de esta spec.

**Fuera de alcance, no resuelto aquí**: montos multi-persona (precio × número de personas) funcionan "gratis" porque el modelo puede hacer esa aritmética él mismo antes de llamar al tool con un `amount_total_cop` ya calculado — pero esto no está específicamente diseñado ni testeado en esta spec. Candidato natural para extender el dataset dorado de spec 10 con casos de tool-calling en una spec futura.

### 8. Cambios al system prompt

Se **agrega** al final de `SYSTEM_PROMPT` (`rag/src/modules/query/system-prompt.constant.ts`), sin tocar el texto existente:

```
Si el usuario expresa intención de pagar o reservar un tour (por ejemplo dice
"quiero pagar", "cómo pago", "resérvame", "dame el link de pago"), usa la
herramienta create_payment_link para generar un link de pago real con Bold.
Usa como descripción el nombre del tour y como monto el precio en pesos
colombianos (COP) que aparece en el contexto — nunca inventes un precio que
no esté en el contexto. Si no encuentras el precio del tour en el contexto,
no generes el link: dile al cliente que no tienes el precio disponible.
Una vez generado el link, compártelo tal cual en tu respuesta junto con una
frase cálida invitando a completar el pago.
```

**Los datos de precio ya existen en los chunks recuperados — no hace falta cambiar el modelo de datos ni el chunking**: evidencia, no supuesto — los fixtures de `query.service.spec.ts` y el dataset dorado de spec 10 (`positive-guatape-nombre-usd`, etc.) ya usan contenido de chunk como `"Tour Guatapé: 180000 COP"` / `"Tour Guatapé + Peñol — 180000 COP / 45 USD"`. El precio en COP llega como texto libre dentro de `chunk.content`, igual que hoy; el tool simplemente le pide al modelo que lo extraiga de ahí en vez de solo citarlo en prosa.

**Paso operativo obligatorio, no solo de código**: como `LangfuseService.getSystemPrompt()` (spec 09) prioriza el prompt gestionado en Langfuse Cloud sobre esta constante siempre que Langfuse esté configurado, el prompt en Langfuse (`query-system-prompt`, label `production`) también debe actualizarse al mismo texto — de lo contrario este cambio no tiene ningún efecto en ningún ambiente con Langfuse activo. `scripts/seed-langfuse-prompt.ts` (spec 09) hoy es **create-only**: si el prompt ya existe y difiere de la constante local, solo imprime una advertencia y no lo sobreescribe (por diseño, para no pisar un cambio manual en el dashboard). Por lo tanto, actualizar el prompt en Langfuse para esta spec es un **paso manual en la UI de Langfuse** (editar el prompt `query-system-prompt` y republicar con label `production`), no algo que el script haga solo — ver criterio de aceptación 10.

## Contratos de API

Sin cambios en la forma del contrato HTTP público de `04-query-endpoint.md`:

**Request** (sin cambios):
```json
{ "question": "quiero pagar el tour a Guatapé", "topK": 3 }
```

**Response** (sin cambios de forma — el link aparece dentro de `answer` como texto):
```json
{
  "answer": "¡Con gusto! Aquí tienes tu link de pago para el Tour Guatapé + Peñol: https://checkout.bold.co/LNK_H7S4xxx. Una vez completes el pago, tu reserva quedará confirmada.",
  "matched": true
}
```

### Contrato interno de Bold consumido por `BoldPaymentsService` (no expuesto directamente por esta API)

**Crear link** — `POST https://integrations.api.bold.co/online/link/v1`

Headers: `Authorization: x-api-key <BOLD_API_KEY>`, `Content-Type: application/json`.

Request enviado por `BoldPaymentsService` (nunca controlado 1:1 por el modelo — ver sección de diseño técnico):
```json
{
  "amount_type": "CLOSE",
  "amount": { "currency": "COP", "total_amount": 180000 },
  "description": "Tour Guatapé + Peñol",
  "expiration_date": 1893456000000000000
}
```

Response esperada:
```json
{
  "payload": { "payment_link": "LNK_H7S4xxx", "url": "https://checkout.bold.co/LNK_H7S4xxx" },
  "errors": []
}
```

## Esquema de datos

N/A — no se crea ni modifica ninguna tabla de Postgres. Sin persistencia de links generados en esta spec (fuera de alcance — ver "Contexto y objetivo"; una futura spec de confirmación de pago por webhook probablemente sí necesitaría una tabla `payment_links` o similar, pero eso no es parte de esta redacción).

## Criterios de aceptación

1. `POST /query` con `{"question": "quiero pagar el tour a Guatapé"}` contra un catálogo con un chunk de Guatapé con precio en COP, y `BOLD_API_KEY` configurada con una key real (idealmente sandbox), devuelve HTTP 200, `matched: true`, y `answer` contiene una URL que matchea `/https:\/\/checkout\.bold\.co\//`.
2. El trace de Langfuse de la request de (1) contiene, en orden: una generation `chat-round-1` cuyo output incluye `toolCalls` con `function.name: "create_payment_link"`; un span `tool-create_payment_link` cuyo output incluye `url` y `paymentLink`; una generation `chat-round-2` cuyo output es el `answer` final.
3. `POST /query` con `{"question": "¿Cuánto cuesta el tour a Guatapé?"}` (pregunta informativa, sin intención de pago) devuelve `answer` sin ningún link de Bold (`expect(answer).not.toMatch(/checkout\.bold\.co/)`), y ninguna generation del trace tiene `toolCalls` — confirma que el modelo no genera links por defecto en cada respuesta.
4. Con `BOLD_API_KEY` sin configurar, `POST /query` con `{"question": "quiero pagar el tour a Guatapé"}` sigue devolviendo HTTP 200 (nunca 500), sin ningún link de Bold en `answer`, y el log de arranque de `BoldPaymentsService` muestra el warning de "herramienta de pago deshabilitada" — confirma la degradación graceful.
5. `bold-payments.service.spec.ts` (nuevo): `createPaymentLink({ description: 'Tour Guatapé', amountCop: 180000 })` con `fetch` mockeado devolviendo `{ payload: { payment_link: 'LNK_H7S4xxx', url: 'https://checkout.bold.co/LNK_H7S4xxx' }, errors: [] }` resuelve a `{ url: 'https://checkout.bold.co/LNK_H7S4xxx', paymentLink: 'LNK_H7S4xxx' }`; el mock de `fetch` fue llamado con header `Authorization: x-api-key <key>` y `JSON.parse(body).amount_type === 'CLOSE'`.
6. `bold-payments.service.spec.ts`: `createPaymentLink({ description: 'x', amountCop: 999999999 })` (por encima de `BOLD_MAX_AMOUNT_COP`) lanza sin llamar a `fetch` (`expect(fetchMock).not.toHaveBeenCalled()`). Mismo chequeo para una `description` de 1 carácter.
7. `query.service.spec.ts` (modificado): con `llmProvider.chat` mockeado para devolver primero un `ChatResult` con `toolCalls` de `create_payment_link` (`amount_total_cop: 180000`), y luego `{ content: 'Aquí tienes tu link: https://checkout.bold.co/LNK_1' }`, y `boldPaymentsService.createPaymentLink` mockeado devolviendo `{ url: 'https://checkout.bold.co/LNK_1', paymentLink: 'LNK_1' }`: `service.ask(...)` devuelve `{ answer: 'Aquí tienes tu link: https://checkout.bold.co/LNK_1', matched: true }`, y `llmProvider.chat` fue llamado exactamente 2 veces.
8. `query.service.spec.ts`: si `llmProvider.chat` devuelve `toolCalls` en cada ronda sin nunca dar contenido final, `service.ask(...)` no lanza, devuelve `answer` igual a `FALLBACK_NO_CONTENT_ANSWER`, y `llmProvider.chat` fue llamado exactamente `MAX_TOOL_ROUNDS + 1` (= 3) veces, nunca más.
9. `query.service.spec.ts`: con `boldPaymentsService.isEnabled` mockeado a `false`, el array `tools` pasado a `llmProvider.chat` en la primera llamada es `[]` (verificable inspeccionando `llmProvider.chat.mock.calls[0][1]`).
10. `npm run build`, `npm run lint`, `npm test` pasan sin errores tras los cambios. Adicionalmente: `system-prompt.constant.ts` incluye la nueva sección sobre `create_payment_link`, y el prompt gestionado en Langfuse (`query-system-prompt`, label `production`) fue actualizado manualmente en la UI al mismo texto — verificable comparando `client.prompt.get('query-system-prompt', { label: 'production' })` contra la constante local.
11. **Validación empírica del riesgo abierto de la sección "Limitación conocida"**: contra Ollama real con `qwen3:8b`, una conversación de dos turnos donde el segundo mensaje `role: 'tool'` lleva un `toolCallId` que corresponde a una tool call específica de una respuesta anterior con **múltiples** `tool_calls` en el mismo turno, produce una respuesta del modelo coherente con el resultado de la tool call correcta (no una respuesta que ignora o confunde los resultados) — si Ollama no correlaciona de forma confiable por `tool_call_id`, este criterio falla explícitamente y se documenta como limitación conocida del provider Ollama (no se oculta ni se fuerza a pasar).
12. Verificación manual: `curl -X POST https://integrations.api.bold.co/online/link/v1 -H "Authorization: x-api-key $BOLD_API_KEY" -H "Content-Type: application/json" -d '{"amount_type":"CLOSE","amount":{"currency":"COP","total_amount":10000},"description":"prueba"}'` devuelve HTTP 200 con `payload.url` no vacío — confirma el contrato asumido de Bold contra la API real antes de que el modelo dependa de él en producción.

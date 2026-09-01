import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChatMessage,
  ChatOptions,
  ChatResult,
  LlmProvider,
  ToolCall,
} from '../llm/llm-provider';

interface OpenAiEmbeddingResponse {
  data: { embedding: number[] }[];
}

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAiChatResponse {
  choices: {
    message: {
      role: string;
      content: string | null;
      tool_calls?: OpenAiToolCall[];
    };
  }[];
}

/**
 * OpenAI ya es la forma canónica elegida para `ToolCall` (arguments como
 * string, id presente) — el mapeo es casi identidad, solo pasa `toolCallId`
 * (camelCase interno) a `tool_call_id` (snake_case, formato de la API) y
 * `toolCalls` a `tool_calls`. Ver spec 11 y el mapeo equivalente, no
 * trivial, en `OllamaProvider`.
 */
function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  const base: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
  if (message.toolCalls?.length) {
    base.tool_calls = message.toolCalls;
  }
  if (message.toolCallId) {
    base.tool_call_id = message.toolCallId;
  }
  return base;
}

function normalizeToolCalls(
  raw: OpenAiToolCall[] | undefined,
): ToolCall[] | undefined {
  if (!raw || raw.length === 0) {
    return undefined;
  }
  return raw.map((call) => ({
    id: call.id,
    type: 'function' as const,
    function: { name: call.function.name, arguments: call.function.arguments },
  }));
}

const EMBED_TIMEOUT_MS = 30_000;
const CHAT_TIMEOUT_MS = 120_000;

/**
 * Cliente HTTP genérico hacia cualquier proveedor compatible con la API de
 * OpenAI (OpenRouter, Groq, Together, LM Studio, o la propia OpenAI) —
 * seleccionable vía LLM_PROVIDER=openai (ver llm-provider.factory.ts).
 * `llm.baseUrl` debe incluir cualquier prefijo de versión que
 * el proveedor requiera (ej. https://openrouter.ai/api/v1); se concatena
 * literal, sin normalización, igual que OllamaProvider con `llm.baseUrl`.
 * Se envía siempre el parámetro `dimensions` (= VECTOR_DIM) en /embeddings,
 * igual que OllamaProvider lo hace vía el parámetro `dimensions` de su
 * `/api/embed` — verificado en vivo contra el endpoint OpenAI-compatible de
 * Gemini (`gemini-embedding-001`), que trunca correctamente de 3072 a 1536
 * dimensiones cuando se envía `dimensions: 1536`. Trade-off conocido:
 * algunos otros proveedores
 * compatibles con la API de OpenAI pueden rechazar un parámetro
 * `dimensions` no reconocido — si eso ocurre con un proveedor específico,
 * es una señal de que el modelo de embedding de ese proveedor no es
 * compatible con este cliente tal cual, no un bug de este código.
 */
@Injectable()
export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(private readonly configService: ConfigService) {}

  async embed(text: string): Promise<number[]> {
    const baseUrl = this.configService.get<string>('llm.baseUrl');
    const apiKey = this.configService.get<string>('llm.apiKey');
    const model = this.configService.get<string>('llm.embeddingModel');
    const dimensions = this.configService.get<number>('vectorDim');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: text, dimensions }),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `No se pudo conectar con el proveedor OpenAI-compatible (${baseUrl}): ${message}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `OpenAI-compatible /embeddings respondió ${response.status}: ${body}`,
      );
    }

    const data = (await response.json()) as OpenAiEmbeddingResponse;
    const embedding = data.data?.[0]?.embedding;
    if (!embedding || embedding.length === 0) {
      throw new Error(
        'OpenAI-compatible /embeddings no devolvió ningún embedding',
      );
    }

    return embedding;
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ChatResult> {
    const baseUrl = this.configService.get<string>('llm.baseUrl');
    const apiKey = this.configService.get<string>('llm.apiKey');
    const model = this.configService.get<string>('llm.chatModel');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: messages.map(toOpenAiMessage),
          stream: false,
          ...(options?.tools ? { tools: options.tools } : {}),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `No se pudo conectar con el proveedor OpenAI-compatible (${baseUrl}): ${message}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `OpenAI-compatible /chat/completions respondió ${response.status}: ${body}`,
      );
    }

    const data = (await response.json()) as OpenAiChatResponse;
    const content = data.choices?.[0]?.message?.content ?? null;
    const toolCalls = normalizeToolCalls(
      data.choices?.[0]?.message?.tool_calls,
    );
    if (content === null && !toolCalls?.length) {
      throw new Error(
        'OpenAI-compatible /chat/completions no devolvió ningún mensaje',
      );
    }

    return { content, toolCalls };
  }
}

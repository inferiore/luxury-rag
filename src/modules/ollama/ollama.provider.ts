import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChatMessage,
  ChatOptions,
  ChatResult,
  LlmProvider,
  ToolCall,
} from '../llm/llm-provider';

interface OllamaEmbedResponse {
  embeddings: number[][];
}

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaChatResponse {
  message: {
    role: string;
    content: string | null;
    tool_calls?: OllamaToolCall[];
  };
}

/**
 * Ollama espera/devuelve `tool_calls[].function.arguments` como objeto JSON
 * (no como string, a diferencia de OpenAI) y no siempre trae un `id` propio
 * por llamada — se normaliza a la forma canónica de `ToolCall` (arguments
 * como string, id sintetizado si falta) para que el resto del sistema
 * (`QueryService`, `OpenAiCompatibleProvider`) trabaje con un único formato
 * sin importar el provider activo. Ver spec 11.
 */
function normalizeToolCalls(
  raw: OllamaToolCall[] | undefined,
): ToolCall[] | undefined {
  if (!raw || raw.length === 0) {
    return undefined;
  }
  return raw.map((call, index) => ({
    id: `call_${index}`,
    type: 'function' as const,
    function: {
      name: call.function.name,
      arguments: JSON.stringify(call.function.arguments),
    },
  }));
}

function toOllamaMessage(message: ChatMessage): Record<string, unknown> {
  const base: Record<string, unknown> = {
    role: message.role,
    content: message.content ?? '',
  };
  if (message.toolCalls?.length) {
    base.tool_calls = message.toolCalls.map((call) => ({
      function: {
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments) as unknown,
      },
    }));
  }
  return base;
}

const EMBED_TIMEOUT_MS = 30_000;
const CHAT_TIMEOUT_MS = 120_000;

/**
 * Cliente HTTP hacia Ollama. `embed()` llama a `POST /api/embed` (NO
 * `/api/embeddings`, el endpoint legacy no soporta el parámetro `dimensions`
 * de truncamiento Matryoshka) — ver 00-arquitectura-general.md.
 * `chat()` llama a `POST /api/chat` con `stream: false` — el modelo puede
 * devolver bloques `<think>...</think>`, que se stripean en el caller
 * (`common/utils/strip-think-tags.ts`), no aquí.
 */
@Injectable()
export class OllamaProvider implements LlmProvider {
  constructor(private readonly configService: ConfigService) {}

  async embed(text: string): Promise<number[]> {
    const baseUrl = this.configService.get<string>('llm.baseUrl');
    const model = this.configService.get<string>('llm.embeddingModel');
    const dimensions = this.configService.get<number>('vectorDim');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text, dimensions }),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `No se pudo conectar con Ollama (${baseUrl}): ${message}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Ollama /api/embed respondió ${response.status}: ${body}`,
      );
    }

    const data = (await response.json()) as OllamaEmbedResponse;
    const embedding = data.embeddings?.[0];
    if (!embedding || embedding.length === 0) {
      throw new Error('Ollama /api/embed no devolvió ningún embedding');
    }

    return embedding;
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ChatResult> {
    const baseUrl = this.configService.get<string>('llm.baseUrl');
    const model = this.configService.get<string>('llm.chatModel');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: messages.map(toOllamaMessage),
          stream: false,
          ...(options?.tools ? { tools: options.tools } : {}),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `No se pudo conectar con Ollama (${baseUrl}): ${message}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama /api/chat respondió ${response.status}: ${body}`);
    }

    const data = (await response.json()) as OllamaChatResponse;
    const content = data.message?.content ?? null;
    const toolCalls = normalizeToolCalls(data.message?.tool_calls);
    if (content === null && !toolCalls?.length) {
      throw new Error('Ollama /api/chat no devolvió ningún mensaje');
    }

    return { content, toolCalls };
  }
}

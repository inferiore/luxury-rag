import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatMessage, LlmProvider } from '../llm/llm-provider';

interface OllamaEmbedResponse {
  embeddings: number[][];
}

interface OllamaChatResponse {
  message: { role: string; content: string };
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

  async chat(messages: ChatMessage[]): Promise<string> {
    const baseUrl = this.configService.get<string>('llm.baseUrl');
    const model = this.configService.get<string>('llm.chatModel');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false }),
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
    const content = data.message?.content;
    if (content === undefined || content === null) {
      throw new Error('Ollama /api/chat no devolvió ningún mensaje');
    }

    return content;
  }
}

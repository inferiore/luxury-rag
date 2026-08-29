import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  LangfuseGenerationClient,
  LangfuseSpanClient,
  LangfuseTraceClient,
  TextPromptClient,
} from 'langfuse';
import { ChunksRepository, NearestChunk } from '../chunks/chunks.repository';
import { LLM_PROVIDER_TOKEN } from '../llm/llm-provider';
import type { LlmProvider } from '../llm/llm-provider';
import { LangfuseService } from '../langfuse/langfuse.service';
import { stripThinkTags } from '../../common/utils/strip-think-tags';
import { QueryResponseDto } from './dto/query-response.dto';
import { SYSTEM_PROMPT } from './system-prompt.constant';

export const NO_MATCH_ANSWER = 'datos no encontrados';

// Reexportado para no romper ningún import existente (ej.
// `scripts/seed-langfuse-prompt.ts`, `query.service.spec.ts`) — la fuente de
// verdad del texto vive en `system-prompt.constant.ts` (ver nota de import
// circular en 09-langfuse-observabilidad-y-prompts.md).
export { SYSTEM_PROMPT };

/**
 * Orquesta el flujo de `/query`: embebe la pregunta, busca por similitud
 * coseno en `chunks` (gate determinista por `SIMILARITY_THRESHOLD`) y, si
 * hay coincidencia razonable, llama a `qwen3:8b` con el contexto recuperado.
 * Todo el flujo se traza en Langfuse de forma best-effort (nunca rompe la
 * respuesta si Langfuse falla o no está configurado).
 */
@Injectable()
export class QueryService {
  private readonly logger = new Logger(QueryService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly chunksRepository: ChunksRepository,
    @Inject(LLM_PROVIDER_TOKEN) private readonly llmProvider: LlmProvider,
    private readonly langfuseService: LangfuseService,
  ) {}

  async ask(
    question: string,
    requestedTopK?: number,
  ): Promise<QueryResponseDto> {
    const defaultTopK =
      this.configService.get<number>('query.defaultTopK') ?? 1;
    const similarityThreshold =
      this.configService.get<number>('query.similarityThreshold') ?? 0.4;
    const topK = requestedTopK ?? defaultTopK;

    const trace = this.startTrace(question, topK);

    const embedSpan = this.startSpan(trace, 'embed-question', { question });
    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.llmProvider.embed(question);
    } catch (error) {
      this.endSpan(embedSpan, undefined, error);
      throw error;
    }
    this.endSpan(embedSpan, { embeddingLength: queryEmbedding.length });

    const searchSpan = this.startSpan(trace, 'similarity-search', { topK });
    const candidates = await this.chunksRepository.findNearest(
      queryEmbedding,
      topK,
    );
    this.endSpan(searchSpan, {
      candidates: candidates.map((c) => ({ id: c.id, distance: c.distance })),
    });

    const best = candidates[0];
    if (!best || best.distance > similarityThreshold) {
      this.trackEvent(trace, 'below_threshold', {
        distance: best?.distance ?? null,
        threshold: similarityThreshold,
      });
      this.endTrace(trace, { answer: NO_MATCH_ANSWER, matched: false });
      return { answer: NO_MATCH_ANSWER, matched: false };
    }

    const answer = await this.askChatModel(trace, question, candidates);
    this.endTrace(trace, { answer, matched: true });

    return { answer, matched: true };
  }

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

    const chatModel = this.configService.get<string>('llm.chatModel');
    const chatGeneration = this.startGeneration(trace, 'chat', {
      input: { messages },
      model: chatModel,
      prompt: promptForTrace ?? undefined,
    });

    let rawAnswer: string;
    try {
      rawAnswer = await this.llmProvider.chat(messages);
    } catch (error) {
      this.endGeneration(chatGeneration, undefined, error);
      throw error;
    }

    const answer = stripThinkTags(rawAnswer);
    this.endGeneration(chatGeneration, { answer });

    return answer;
  }

  // --- Helpers de tracing: best-effort, nunca rompen /query ---

  private startTrace(
    question: string,
    topK: number,
  ): LangfuseTraceClient | null {
    const client = this.langfuseService.client;
    if (!client) {
      return null;
    }
    try {
      return client.trace({ name: 'query', input: { question, topK } });
    } catch (error) {
      this.logWarn('No se pudo iniciar el trace de Langfuse', error);
      return null;
    }
  }

  private endTrace(trace: LangfuseTraceClient | null, output: unknown): void {
    if (!trace) {
      return;
    }
    try {
      trace.update({ output });
    } catch (error) {
      this.logWarn('No se pudo actualizar el trace de Langfuse', error);
    }
  }

  private startSpan(
    trace: LangfuseTraceClient | null,
    name: string,
    input?: unknown,
  ): LangfuseSpanClient | null {
    if (!trace) {
      return null;
    }
    try {
      return trace.span({ name, input });
    } catch (error) {
      this.logWarn(`No se pudo iniciar el span '${name}' de Langfuse`, error);
      return null;
    }
  }

  private endSpan(
    span: LangfuseSpanClient | null,
    output?: unknown,
    error?: unknown,
  ): void {
    if (!span) {
      return;
    }
    const hasError = error !== undefined;
    const statusMessage = hasError ? this.errorMessage(error) : undefined;
    try {
      span.end({
        output,
        level: hasError ? 'ERROR' : undefined,
        statusMessage,
      });
    } catch (spanError) {
      this.logWarn('No se pudo cerrar un span de Langfuse', spanError);
    }
  }

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

  private trackEvent(
    trace: LangfuseTraceClient | null,
    name: string,
    input: unknown,
  ): void {
    if (!trace) {
      return;
    }
    try {
      trace.event({ name, input });
    } catch (error) {
      this.logWarn(
        `No se pudo registrar el evento '${name}' de Langfuse`,
        error,
      );
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private logWarn(message: string, error: unknown): void {
    this.logger.warn(`${message}: ${this.errorMessage(error)}`);
  }
}

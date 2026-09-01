import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { startObservation } from '@langfuse/tracing';
import type { LangfuseGeneration, LangfuseSpan } from '@langfuse/tracing';
import type { TextPromptClient } from '@langfuse/client';
import { ChunksRepository, NearestChunk } from '../chunks/chunks.repository';
import { LLM_PROVIDER_TOKEN } from '../llm/llm-provider';
import type {
  ChatMessage,
  ChatResult,
  LlmProvider,
  ToolCall,
  ToolDefinition,
} from '../llm/llm-provider';
import { LangfuseService } from '../langfuse/langfuse.service';
import { BoldPaymentsService } from '../bold-payments/bold-payments.service';
import { stripThinkTags } from '../../common/utils/strip-think-tags';
import { QueryResponseDto } from './dto/query-response.dto';
import { SYSTEM_PROMPT } from './system-prompt.constant';
import {
  CREATE_PAYMENT_LINK_TOOL,
  CREATE_PAYMENT_LINK_TOOL_NAME,
} from './tools/create-payment-link.tool';

export const NO_MATCH_ANSWER = 'datos no encontrados';

// Tope duro de rondas extra de tool-calling (spec 11) — máx.
// MAX_TOOL_ROUNDS + 1 llamadas al modelo por request. La última ronda
// permitida se manda sin `tools`, forzando texto: es la válvula de salida
// del loop, no un límite pensado para alcanzarse en el camino feliz.
const MAX_TOOL_ROUNDS = 2;
const FALLBACK_NO_CONTENT_ANSWER =
  'No pude generar una respuesta, por favor intenta de nuevo.';

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
 *
 * Excepción al gate determinista (spec 11): si la búsqueda no encuentra
 * nada relevante Y Bold está habilitado, se hace una clasificación barata
 * de intención de pago antes de rendirse — una pregunta como "generame un
 * link de pago" no menciona ningún tour, así que su embedding nunca va a
 * matchear un chunk, pero sí debería llegar al modelo para que pida el
 * nombre del tour en vez de recibir "datos no encontrados" sin más. Ver
 * `detectPaymentIntent`.
 */
@Injectable()
export class QueryService {
  private readonly logger = new Logger(QueryService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly chunksRepository: ChunksRepository,
    @Inject(LLM_PROVIDER_TOKEN) private readonly llmProvider: LlmProvider,
    private readonly langfuseService: LangfuseService,
    private readonly boldPaymentsService: BoldPaymentsService,
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
    const relevant = candidates.filter(
      (c) => c.distance <= similarityThreshold,
    );
    this.endSpan(searchSpan, {
      candidates: candidates.map((c) => ({
        id: c.id,
        distance: c.distance,
        withinThreshold: c.distance <= similarityThreshold,
      })),
      relevantCount: relevant.length,
    });

    if (relevant.length === 0) {
      // Antes de rendirse: si Bold está habilitado, la pregunta puede ser
      // una intención de pago que no menciona ningún tour por nombre (ej.
      // "generame un link de pago") — su embedding nunca va a parecerse a
      // ningún chunk del catálogo, así que el gate de similitud (pensado
      // para preguntas informativas, spec 04) la descartaría sin darle al
      // modelo la oportunidad de pedir el nombre del tour. Solo se paga el
      // costo de esta clasificación extra en este caso borde — el camino
      // feliz (pregunta ya matchea un tour) nunca la ejecuta. Ver spec 11.
      const boldEnable = this.boldPaymentsService.isEnabled();
      const paymentIntent = boldEnable
        ? await this.detectPaymentIntent(trace, question)
        : false;

      if (!paymentIntent) {
        this.trackEvent(trace, 'below_threshold', {
          distance: candidates[0]?.distance ?? null,
          threshold: similarityThreshold,
          paymentIntent,
          boldEnable,
        });
        this.endTrace(trace, {
          answer: NO_MATCH_ANSWER,
          matched: false,
          paymentIntent,
          boldEnable,
        });
        return { answer: NO_MATCH_ANSWER, matched: false };
      }
      // Intención de pago detectada sin tour matcheado: se sigue con
      // `relevant` vacío — el system prompt instruye al modelo a pedir el
      // nombre del tour en vez de inventar un precio (ver
      // system-prompt.constant.ts).
    }

    // `matched` para el frontend significa "hay una respuesta real que
    // mostrar", no "hubo match técnico de RAG" — el frontend descarta
    // `answer` por completo y muestra un mensaje fijo cuando `matched` es
    // `false` (ver AskView.tsx), así que cualquier respuesta genuina del
    // modelo (incluida la rama de intención de pago sin tour matcheado, que
    // puede generar un link real) debe llegar como `matched: true`. Solo
    // `NO_MATCH_ANSWER` (arriba) usa `matched: false`. Corrección
    // post-aprobación de spec 11 (2026-09-01).
    const answer = await this.askChatModel(trace, question, relevant);
    this.endTrace(trace, { answer, matched: true });

    return { answer, matched: true };
  }

  /**
   * Clasificación barata de intención vía LLM (sin tools) — solo se llama
   * cuando la búsqueda de similitud no encontró nada relevante (spec 11).
   * Best-effort: si la clasificación falla, se asume que NO es intención de
   * pago (comportamiento previo, ya validado) en vez de romper /query.
   */
  private async detectPaymentIntent(
    trace: LangfuseSpan | null,
    question: string,
  ): Promise<boolean> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'Eres un clasificador. Responde únicamente con la palabra SI o la palabra NO, sin explicación ni texto adicional.',
      },
      {
        role: 'user',
        content:
          '¿La siguiente pregunta pide crear o generar un link de pago ' +
          '(por ejemplo "generame un link de pago", "créame un link de pago por 50000", ' +
          '"quiero pagar", "cóbrale a alguien"), incluso si no menciona ningún ' +
          `tour ni da el monto todavía?\n\nPregunta: "${question}"`,
      },
    ];

    const generation = this.startGeneration(trace, 'intent-classification', {
      input: { messages },
      model: this.configService.get<string>('llm.chatModel'),
    });

    try {
      const result = await this.llmProvider.chat(messages);
      const isPaymentIntent = (result.content ?? '')
        .trim()
        .toUpperCase()
        .startsWith('SI');
      this.endGeneration(generation, { isPaymentIntent });
      return isPaymentIntent;
    } catch (error) {
      this.endGeneration(generation, undefined, error);
      this.logWarn(
        'No se pudo clasificar la intención de pago, se asume que no es de pago',
        error,
      );
      return false;
    }
  }

  private async askChatModel(
    trace: LangfuseSpan | null,
    question: string,
    candidates: NearestChunk[],
  ): Promise<string> {
    const { text: systemPromptText, promptForTrace } =
      await this.langfuseService.getSystemPrompt();

    const context = candidates
      .map((c, i) => `[Tour ${i + 1}]\n${c.content}`)
      .join('\n\n---\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPromptText },
      {
        role: 'user',
        content: `Contexto:\n${context}\n\nPregunta: ${question}`,
      },
    ];

    const tools = this.buildAvailableTools();
    const chatModel = this.configService.get<string>('llm.chatModel');

    // Si un tool ya se ejecutó con éxito (ej. el link de pago YA se creó en
    // Bold — una acción con efecto secundario real, no repetible sin
    // riesgo) y la ronda de SEGUIMIENTO falla por cualquier motivo (un
    // proveedor exigiendo un campo que no reenviamos bien, un 429, lo que
    // sea), no tiene sentido tirar la respuesta a la basura con un 500 —
    // se usa el resultado del tool directamente como fallback.
    let lastSuccessfulToolAnswer: string | null = null;

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
        if (lastSuccessfulToolAnswer) {
          this.logWarn(
            'Falló la ronda de seguimiento tras un tool call ya exitoso — se usa el resultado del tool directamente',
            error,
          );
          return lastSuccessfulToolAnswer;
        }
        throw error;
      }
      this.endGeneration(generation, result);

      if (!result.toolCalls?.length) {
        return stripThinkTags(result.content ?? FALLBACK_NO_CONTENT_ANSWER);
      }

      messages.push({
        role: 'assistant',
        content: result.content,
        toolCalls: result.toolCalls,
      });

      for (const toolCall of result.toolCalls) {
        const toolSpan = this.startSpan(
          trace,
          `tool-${toolCall.function.name}`,
          {
            arguments: toolCall.function.arguments,
          },
        );
        const toolResultContent = await this.executeToolCall(toolCall);
        this.endSpan(toolSpan, { result: toolResultContent });
        messages.push({
          role: 'tool',
          toolCallId: toolCall.id,
          content: toolResultContent,
        });

        const fallbackAnswer = this.buildFallbackAnswerFromToolResult(
          toolCall.function.name,
          toolResultContent,
        );
        if (fallbackAnswer) {
          lastSuccessfulToolAnswer = fallbackAnswer;
        }
      }
    }

    return (
      lastSuccessfulToolAnswer ?? FALLBACK_NO_CONTENT_ANSWER // inalcanzable en la práctica, red de seguridad
    );
  }

  /**
   * Construye una respuesta legible directamente desde el resultado crudo
   * (JSON) de un tool call exitoso, para usar como fallback si una ronda de
   * seguimiento del modelo falla. Devuelve `null` si el resultado fue un
   * error (nunca se usa un error como fallback) o si el tool no se reconoce.
   */
  private buildFallbackAnswerFromToolResult(
    toolName: string,
    toolResultContent: string,
  ): string | null {
    if (toolName !== CREATE_PAYMENT_LINK_TOOL_NAME) {
      return null;
    }
    try {
      const parsed = JSON.parse(toolResultContent) as {
        error?: unknown;
        url?: unknown;
      };
      if (parsed.error || typeof parsed.url !== 'string') {
        return null;
      }
      return `Aquí tienes tu link de pago: ${parsed.url}`;
    } catch {
      return null;
    }
  }

  private buildAvailableTools(): ToolDefinition[] {
    return this.boldPaymentsService.isEnabled()
      ? [CREATE_PAYMENT_LINK_TOOL]
      : [];
  }

  /** Nunca lanza — cualquier error se convierte en contenido de mensaje `tool` que el modelo puede leer y responder. */
  private async executeToolCall(toolCall: ToolCall): Promise<string> {
    try {
      if (toolCall.function.name !== CREATE_PAYMENT_LINK_TOOL_NAME) {
        return JSON.stringify({
          error: `Herramienta desconocida: ${toolCall.function.name}`,
        });
      }

      const args = JSON.parse(toolCall.function.arguments) as {
        description?: unknown;
        amount_total_cop?: unknown;
      };
      if (typeof args.amount_total_cop !== 'number') {
        return JSON.stringify({
          error:
            'Argumentos inválidos para create_payment_link: se requiere amount_total_cop (number)',
        });
      }
      // `description` es opcional (spec 11, corrección post-aprobación) —
      // solo se pasa si el modelo la mandó como string; cualquier otra cosa
      // (null, undefined, tipo incorrecto) se trata como "sin descripción".
      const description =
        typeof args.description === 'string' ? args.description : undefined;

      const result = await this.boldPaymentsService.createPaymentLink({
        description,
        amountCop: args.amount_total_cop,
      });
      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({ error: this.errorMessage(error) });
    }
  }

  // --- Helpers de tracing: best-effort, nunca rompen /query ---
  //
  // Migración v4/v5 (OTEL-based): ya no dependen de `LangfuseService.client`
  // — `startObservation` de `@langfuse/tracing` funciona contra el tracer
  // OTEL global registrado en `src/instrumentation.ts`; si Langfuse no está
  // configurado ahí, el `LangfuseSpanProcessor` nunca se registra y estas
  // observaciones simplemente no se exportan a ningún lado (no-op), sin
  // necesidad de un chequeo de cliente nulo en este servicio. El try/catch
  // se conserva de todos modos como defensa explícita — no confiar
  // únicamente en la garantía del SDK de no lanzar.

  private startTrace(question: string, topK: number): LangfuseSpan | null {
    try {
      return startObservation('query', { input: { question, topK } });
    } catch (error) {
      this.logWarn('No se pudo iniciar el trace de Langfuse', error);
      return null;
    }
  }

  private endTrace(trace: LangfuseSpan | null, output: unknown): void {
    if (!trace) {
      return;
    }
    try {
      trace.update({ output }).end();
    } catch (error) {
      this.logWarn('No se pudo actualizar el trace de Langfuse', error);
    }
  }

  private startSpan(
    trace: LangfuseSpan | null,
    name: string,
    input?: unknown,
  ): LangfuseSpan | null {
    if (!trace) {
      return null;
    }
    try {
      return trace.startObservation(name, { input });
    } catch (error) {
      this.logWarn(`No se pudo iniciar el span '${name}' de Langfuse`, error);
      return null;
    }
  }

  private endSpan(
    span: LangfuseSpan | null,
    output?: unknown,
    error?: unknown,
  ): void {
    if (!span) {
      return;
    }
    const hasError = error !== undefined;
    const statusMessage = hasError ? this.errorMessage(error) : undefined;
    try {
      span
        .update({
          output,
          level: hasError ? 'ERROR' : undefined,
          statusMessage,
        })
        .end();
    } catch (spanError) {
      this.logWarn('No se pudo cerrar un span de Langfuse', spanError);
    }
  }

  private startGeneration(
    trace: LangfuseSpan | null,
    name: string,
    params: { input?: unknown; model?: string; prompt?: TextPromptClient },
  ): LangfuseGeneration | null {
    if (!trace) {
      return null;
    }
    try {
      return trace.startObservation(
        name,
        {
          input: params.input,
          model: params.model,
          prompt: params.prompt
            ? {
                name: params.prompt.name,
                version: params.prompt.version,
                isFallback: params.prompt.isFallback,
              }
            : undefined,
        },
        { asType: 'generation' },
      );
    } catch (error) {
      this.logWarn(
        `No se pudo iniciar la generation '${name}' de Langfuse`,
        error,
      );
      return null;
    }
  }

  private endGeneration(
    generation: LangfuseGeneration | null,
    output?: unknown,
    error?: unknown,
  ): void {
    if (!generation) {
      return;
    }
    const hasError = error !== undefined;
    const statusMessage = hasError ? this.errorMessage(error) : undefined;
    try {
      generation
        .update({
          output,
          level: hasError ? 'ERROR' : undefined,
          statusMessage,
        })
        .end();
    } catch (genError) {
      this.logWarn('No se pudo cerrar una generation de Langfuse', genError);
    }
  }

  private trackEvent(
    trace: LangfuseSpan | null,
    name: string,
    input: unknown,
  ): void {
    if (!trace) {
      return;
    }
    try {
      trace.startObservation(name, { input }, { asType: 'event' });
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

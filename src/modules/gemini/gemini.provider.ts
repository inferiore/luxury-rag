import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Content, FunctionDeclaration, GoogleGenAI, Part } from '@google/genai';
import {
  ChatMessage,
  ChatOptions,
  ChatResult,
  LlmProvider,
  ToolCall,
  ToolDefinition,
} from '../llm/llm-provider';

/**
 * Cliente hacia Gemini vía el SDK oficial (`@google/genai`), autenticado en
 * modo Vertex AI Express (API key simple, sin proyecto/región — ver
 * `GoogleGenAI({ vertexai: true, apiKey })`).
 *
 * Existe para reemplazar, en tool-calling multi-turno, el manejo manual del
 * endpoint OpenAI-compatible de Gemini (`OpenAiCompatibleProvider`): Gemini
 * exige reenviar un campo opaco (`thoughtSignature`) en cada `Part` cuando
 * se continúa una conversación con llamadas a funciones, y el SDK oficial
 * lo maneja automáticamente siempre que se le reenvíen los mismos objetos
 * `Content`/`Part` que él mismo devolvió, sin que este código necesite
 * conocer su formato exacto (motivo del incidente de producción del
 * 2026-09-01 contra el endpoint OpenAI-compatible — ver
 * `hotfix-gemini-thought-signature`).
 *
 * `LlmProvider.chat()` es stateless: recibe el array `messages` completo en
 * cada llamada, no hay una sesión de Gemini persistente entre rounds del
 * loop de tool-calling de `QueryService` (un provider es un singleton de
 * Nest, compartido entre requests concurrentes — no puede guardar estado de
 * conversación él mismo). Por eso este provider reconstruye un `Chat` del
 * SDK en cada llamada a partir de `messages`, usando el `Content` crudo
 * guardado en `ToolCall.raw` (ver `llm-provider.ts`) para los turnos del
 * modelo que tuvieron tool calls, en vez de reconstruirlo desde los campos
 * que sí conocemos — así se reenvía exactamente el mismo objeto que Gemini
 * generó, `thoughtSignature` incluido.
 *
 * ⚠️ No verificado en vivo contra Vertex AI Express Mode real (sin
 * credenciales en este entorno de desarrollo) — ver criterios de
 * verificación manual en el PR que introduce este archivo.
 */
@Injectable()
export class GeminiProvider implements LlmProvider {
  constructor(private readonly configService: ConfigService) {}

  private getClient(): GoogleGenAI {
    const apiKey = this.configService.get<string>('llm.apiKey');
    return new GoogleGenAI({ vertexai: true, apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const ai = this.getClient();
    const model = this.configService.get<string>('llm.embeddingModel') ?? '';
    const dimensions = this.configService.get<number>('vectorDim');

    let response;
    try {
      response = await ai.models.embedContent({
        model,
        contents: text,
        config: { outputDimensionality: dimensions },
      });
    } catch (error) {
      throw new Error(`Gemini embedContent falló: ${this.errorMessage(error)}`);
    }

    const embedding = response.embeddings?.[0]?.values;
    if (!embedding || embedding.length === 0) {
      throw new Error('Gemini embedContent no devolvió ningún embedding');
    }

    return embedding;
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ChatResult> {
    const ai = this.getClient();
    const model = this.configService.get<string>('llm.chatModel') ?? '';

    const systemMessage = messages.find((m) => m.role === 'system');
    const turns = messages.filter((m) => m.role !== 'system');
    const lastTurn = turns[turns.length - 1];
    const history = turns
      .slice(0, -1)
      .map((message, index) => toGeminiContent(message, turns, index));

    const chat = ai.chats.create({
      model,
      history,
      config: {
        systemInstruction: systemMessage?.content ?? undefined,
        tools: options?.tools?.length
          ? [
              {
                functionDeclarations: options.tools.map(
                  toGeminiFunctionDeclaration,
                ),
              },
            ]
          : undefined,
      },
    });

    const lastContent = toGeminiContent(lastTurn, turns, turns.length - 1);

    let response;
    try {
      response = await chat.sendMessage({
        message: lastContent.parts ?? [],
      });
    } catch (error) {
      throw new Error(`Gemini chat falló: ${this.errorMessage(error)}`);
    }

    const functionCalls = response.functionCalls;
    if (!functionCalls?.length) {
      const content = response.text ?? null;
      if (content === null) {
        throw new Error('Gemini no devolvió ningún mensaje');
      }
      return { content };
    }

    // El Content crudo del turno del modelo (con thoughtSignature intacto
    // en sus Parts) — se guarda en cada ToolCall.raw para reenviarlo tal
    // cual si el loop de tool-calling de QueryService hace otra ronda.
    const modelTurn = chat.getHistory(true).at(-1);
    const toolCalls: ToolCall[] = functionCalls.map((call, index) => ({
      id: call.id ?? `call_${index}`,
      type: 'function',
      function: {
        name: call.name ?? '',
        arguments: JSON.stringify(call.args ?? {}),
      },
      raw: modelTurn,
    }));

    return { content: null, toolCalls };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function toGeminiFunctionDeclaration(
  tool: ToolDefinition,
): FunctionDeclaration {
  return {
    name: tool.function.name,
    description: tool.function.description,
    parametersJsonSchema: tool.function.parameters,
  };
}

/**
 * Convierte un `ChatMessage` canónico a un `Content` de Gemini.
 *
 * - `role: 'assistant'` con `toolCalls`: si `toolCalls[0].raw` es el
 *   `Content` original devuelto por Gemini (lo es, siempre que el mensaje
 *   venga de ESTE provider — ver `chat()` arriba), se reenvía tal cual, sin
 *   reconstruirlo. Solo se reconstruye desde cero como fallback defensivo
 *   (ej. si `raw` no está presente por algún motivo).
 * - `role: 'tool'`: se busca el nombre de la función en el `toolCalls` del
 *   mensaje `assistant` anterior que declaró ese `toolCallId` (Gemini no lo
 *   requiere estrictamente — `FunctionResponse.id` alcanza para
 *   correlacionar — pero se incluye si está disponible).
 * - `role: 'user'`: texto plano.
 */
function toGeminiContent(
  message: ChatMessage,
  allTurns: ChatMessage[],
  index: number,
): Content {
  if (message.role === 'assistant' && message.toolCalls?.length) {
    const rawContent = message.toolCalls[0].raw as Content | undefined;
    if (rawContent) {
      return rawContent;
    }
    return {
      role: 'model',
      parts: message.toolCalls.map((call) => ({
        functionCall: {
          id: call.id,
          name: call.function.name,
          args: JSON.parse(call.function.arguments) as Record<string, unknown>,
        },
      })),
    };
  }

  if (message.role === 'tool') {
    const functionName = findToolCallName(allTurns, index, message.toolCallId);
    const part: Part = {
      functionResponse: {
        id: message.toolCallId,
        name: functionName,
        response: { output: message.content },
      },
    };
    return { role: 'user', parts: [part] };
  }

  return { role: 'user', parts: [{ text: message.content ?? '' }] };
}

function findToolCallName(
  turns: ChatMessage[],
  fromIndex: number,
  toolCallId: string | undefined,
): string | undefined {
  if (!toolCallId) {
    return undefined;
  }
  for (let i = fromIndex - 1; i >= 0; i--) {
    const match = turns[i].toolCalls?.find((call) => call.id === toolCallId);
    if (match) {
      return match.function.name;
    }
  }
  return undefined;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON-string — forma canónica tipo OpenAI, independiente del wire format del provider
  };
  /**
   * Objeto crudo tal como lo devolvió el provider, si lo hay — passthrough
   * de uso interno de cada provider (no lo lee `QueryService`). Existe
   * porque algunos providers (ej. Gemini vía el endpoint OpenAI-compatible)
   * agregan campos no estándar al tool call (ej. `thought_signature`) que
   * deben reenviarse tal cual en la siguiente ronda de la conversación, sin
   * que el resto del sistema necesite conocer su forma exacta. Ver
   * `OpenAiCompatibleProvider`.
   */
  raw?: unknown;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null; // null solo válido en un mensaje assistant que es puramente tool-call
  toolCalls?: ToolCall[]; // solo en mensajes assistant
  toolCallId?: string; // solo en mensajes role: 'tool', correlaciona con ToolCall.id
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface ChatOptions {
  tools?: ToolDefinition[];
}

export interface ChatResult {
  content: string | null;
  toolCalls?: ToolCall[];
}

export interface LlmProvider {
  embed(text: string): Promise<number[]>;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;
}

export const LLM_PROVIDER_TOKEN = 'LLM_PROVIDER_TOKEN';

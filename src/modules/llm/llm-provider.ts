export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmProvider {
  embed(text: string): Promise<number[]>;
  chat(messages: ChatMessage[]): Promise<string>;
}

export const LLM_PROVIDER_TOKEN = 'LLM_PROVIDER_TOKEN';

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Langfuse } from 'langfuse';
import type { TextPromptClient } from 'langfuse';
import { SYSTEM_PROMPT } from '../query/system-prompt.constant';

const SYSTEM_PROMPT_NAME = 'query-system-prompt';

/**
 * Wrapper fino sobre el SDK de Langfuse. Si `LANGFUSE_PUBLIC_KEY`/
 * `LANGFUSE_SECRET_KEY` no están configuradas, `client` queda `null` y el
 * tracing se deshabilita silenciosamente (loguea y sigue) — el tracing es
 * best-effort, nunca debe romper `/query` (criterio de aceptación #9 de
 * 04-query-endpoint.md).
 */
@Injectable()
export class LangfuseService implements OnModuleDestroy {
  private readonly logger = new Logger(LangfuseService.name);
  readonly client: Langfuse | null;

  constructor(private readonly configService: ConfigService) {
    const publicKey = this.configService.get<string>('langfuse.publicKey');
    const secretKey = this.configService.get<string>('langfuse.secretKey');
    const baseUrl = this.configService.get<string>('langfuse.host');

    if (!publicKey || !secretKey) {
      this.logger.warn(
        'LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY no configuradas — tracing deshabilitado',
      );
      this.client = null;
      return;
    }

    const usingDeprecatedAlias = this.configService.get<boolean>(
      'langfuse.usingDeprecatedHostAlias',
    );
    if (usingDeprecatedAlias) {
      this.logger.warn(
        `Usando LANGFUSE_BASE_URL como alias deprecado de LANGFUSE_HOST (host resuelto: ${baseUrl}). ` +
          'Renombra la variable a LANGFUSE_HOST en tu .env cuando puedas.',
      );
    }

    this.client = new Langfuse({ publicKey, secretKey, baseUrl });

    this.logger.log(`Cliente de Langfuse inicializado — host: ${baseUrl}`);
  }

  isEnabled(): boolean {
    return this.client !== null;
  }

  /**
   * Devuelve el system prompt de `/query` desde Langfuse Prompt Management
   * (label `production`), con fallback local a la constante `SYSTEM_PROMPT`
   * si Langfuse está deshabilitado o la llamada falla — nunca lanza (mismo
   * contrato best-effort que el resto de `LangfuseService`/`QueryService`,
   * criterio de aceptación #9 de 04-query-endpoint.md).
   */
  async getSystemPrompt(): Promise<{
    text: string;
    promptForTrace: TextPromptClient | null;
  }> {
    if (!this.client) {
      return { text: SYSTEM_PROMPT, promptForTrace: null };
    }
    try {
      const prompt = await this.client.getPrompt(
        SYSTEM_PROMPT_NAME,
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

  async onModuleDestroy(): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      await this.client.shutdownAsync();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Error al cerrar el cliente de Langfuse: ${message}`);
    }
  }

  private logWarn(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.logger.warn(`${message}: ${detail}`);
  }
}

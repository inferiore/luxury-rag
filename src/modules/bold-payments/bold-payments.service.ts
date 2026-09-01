import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
const NANOSECONDS_PER_HOUR = 60 * 60 * 1_000_000_000;

/**
 * Cliente HTTP hacia la API de Links de Pago de Bold
 * (https://developers.bold.co/pagos-en-linea/api-integration). Mismo patrón
 * que `OllamaProvider`/`OpenAiCompatibleProvider`: fetch nativo,
 * AbortController para timeout, tipos locales de respuesta. Ver spec
 * `11-bold-payment-links.md`.
 *
 * `amount_type`/`currency` quedan fijos server-side (`CLOSE`/`COP`) — el
 * modelo nunca los controla, solo `description`/`amountCop`. Los guardrails
 * de `validateGuardrails` corren SIEMPRE antes de cualquier llamada HTTP:
 * son la barrera de seguridad real contra un monto/descripción manipulados
 * vía prompt injection, el JSON Schema que ve el modelo (ver
 * `create-payment-link.tool.ts`) es solo una sugerencia de forma.
 */
@Injectable()
export class BoldPaymentsService {
  private readonly logger = new Logger(BoldPaymentsService.name);

  constructor(private readonly configService: ConfigService) {
    if (!this.isEnabled()) {
      this.logger.warn(
        'BOLD_API_KEY no configurada — herramienta de pago deshabilitada',
      );
    }
  }

  isEnabled(): boolean {
    return !!this.configService.get<string>('boldPayments.apiKey');
  }

  async createPaymentLink(
    params: CreatePaymentLinkParams,
  ): Promise<PaymentLinkResult> {
    this.validateGuardrails(params);

    const apiKey = this.configService.get<string>('boldPayments.apiKey');
    const baseUrl = this.configService.get<string>('boldPayments.baseUrl');
    const expirationHours =
      this.configService.get<number>('boldPayments.linkExpirationHours') ?? 24;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BOLD_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/online/link/v1`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `x-api-key ${apiKey}`,
        },
        body: JSON.stringify({
          amount_type: 'CLOSE',
          amount: { currency: 'COP', total_amount: params.amountCop },
          description: params.description,
          expiration_date:
            Date.now() * 1_000_000 + expirationHours * NANOSECONDS_PER_HOUR,
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
      throw new Error(
        `Bold /online/link/v1 respondió ${response.status}: ${body}`,
      );
    }

    const data = (await response.json()) as BoldCreateLinkResponse;
    if (data.errors?.length) {
      throw new Error(`Bold devolvió errores: ${JSON.stringify(data.errors)}`);
    }

    return { url: data.payload.url, paymentLink: data.payload.payment_link };
  }

  private validateGuardrails(params: CreatePaymentLinkParams): void {
    const min =
      this.configService.get<number>('boldPayments.minAmountCop') ?? 1_000;
    const max =
      this.configService.get<number>('boldPayments.maxAmountCop') ?? 5_000_000;

    if (params.description.length < 2 || params.description.length > 100) {
      throw new Error(
        'La descripción del pago debe tener entre 2 y 100 caracteres',
      );
    }
    if (
      !Number.isInteger(params.amountCop) ||
      params.amountCop < min ||
      params.amountCop > max
    ) {
      throw new Error(`El monto debe ser un entero entre ${min} y ${max} COP`);
    }
  }
}

import { ToolDefinition } from '../../llm/llm-provider';

export const CREATE_PAYMENT_LINK_TOOL_NAME = 'create_payment_link';

/**
 * Superficie controlada por el modelo reducida a dos campos
 * (`description`, `amount_total_cop`) — todo lo demás que Bold acepta
 * (amount_type, currency, callback_url, payment_methods, etc.) queda
 * hardcodeado server-side en `BoldPaymentsService`. Los límites `minimum`/
 * `maximum` de aquí son solo una sugerencia de forma para el modelo; la
 * barrera de seguridad real es el guardrail de monto server-side de
 * `BoldPaymentsService.validateGuardrails`.
 *
 * No es un tool para que un cliente final pague un tour del catálogo — es
 * un atajo interno para crear un link de pago sin abrir la app de Bold:
 * quien lo pide ya indica el monto directamente en su mensaje, por eso
 * `amount_total_cop` no depende del contexto de RAG. `description` es
 * opcional (igual que en la API de Bold) — no se exige ni se valida su
 * presencia. Ver spec 11, corrección post-aprobación 2026-09-01.
 */
export const CREATE_PAYMENT_LINK_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: CREATE_PAYMENT_LINK_TOOL_NAME,
    description:
      'Genera un link de pago real de Bold. Úsalo cuando el usuario pida ' +
      'crear/generar un link de pago (ej. "generame un link de pago", ' +
      '"créame un link de pago por 50000", "quiero cobrar $30.000"). El ' +
      'monto es el que el usuario indique explícitamente en su mensaje — no ' +
      'hace falta que corresponda a ningún tour del catálogo. Si el usuario ' +
      'menciona para qué es el pago, inclúyelo como descripción; si no dice ' +
      'nada, omite la descripción por completo.',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: ['string', 'null'],
          maxLength: 100,
          description:
            'Descripción corta y opcional del pago, si el usuario la mencionó. Omitir o null si no dijo nada.',
        },
        amount_total_cop: {
          type: 'integer',
          minimum: 1000,
          maximum: 5000000,
          description:
            'Monto total a cobrar en COP indicado por el usuario, sin puntos ni símbolos.',
        },
      },
      required: ['amount_total_cop'],
      additionalProperties: false,
    },
  },
};

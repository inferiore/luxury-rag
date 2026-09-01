import { ToolDefinition } from '../../llm/llm-provider';

export const CREATE_PAYMENT_LINK_TOOL_NAME = 'create_payment_link';

/**
 * Superficie controlada por el modelo deliberadamente reducida a dos campos
 * (`description`, `amount_total_cop`) — todo lo demás que Bold acepta
 * (amount_type, currency, callback_url, payment_methods, etc.) queda
 * hardcodeado server-side en `BoldPaymentsService`. Los límites `minimum`/
 * `maximum` de aquí son solo una sugerencia de forma para el modelo; la
 * barrera de seguridad real es el guardrail server-side de
 * `BoldPaymentsService.validateGuardrails`. Ver spec 11.
 */
export const CREATE_PAYMENT_LINK_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: CREATE_PAYMENT_LINK_TOOL_NAME,
    description:
      'Genera un link de pago real de Bold para que el cliente pague un tour. ' +
      'Úsalo únicamente cuando el usuario exprese intención clara de pagar o ' +
      'reservar (ej. "quiero pagar", "cómo pago", "resérvame"). El monto debe ' +
      'corresponder al precio en pesos colombianos (COP) del tour mencionado ' +
      'en el contexto entregado — nunca inventes un precio que no esté ahí.',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          minLength: 2,
          maxLength: 100,
          description:
            'Descripción corta del pago, ej. "Tour Guatapé + Peñol - 1 persona".',
        },
        amount_total_cop: {
          type: 'integer',
          minimum: 1000,
          maximum: 5000000,
          description: 'Monto total a cobrar en COP, sin puntos ni símbolos.',
        },
      },
      required: ['description', 'amount_total_cop'],
      additionalProperties: false,
    },
  },
};

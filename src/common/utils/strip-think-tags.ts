/**
 * `qwen3:8b` puede emitir bloques `<think>...</think>` con su razonamiento
 * interno antes de la respuesta final. Estos bloques NUNCA deben llegar al
 * cliente (ver 00-arquitectura-general.md líneas 16 y 45, y criterio de
 * aceptación #2 de 04-query-endpoint.md) — esta utilidad los elimina.
 *
 * Cubre:
 * - Bloques completos `<think>...</think>` (incluso multilínea).
 * - Bloques sin cerrar (el modelo cortó la generación a mitad del `<think>`),
 *   en cuyo caso se descarta todo desde `<think>` hasta el final del texto.
 */
export function stripThinkTags(text: string): string {
  if (!text) {
    return '';
  }

  const withoutClosedBlocks = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const withoutDanglingBlock = withoutClosedBlocks.replace(
    /<think>[\s\S]*$/i,
    '',
  );

  return withoutDanglingBlock.trim();
}

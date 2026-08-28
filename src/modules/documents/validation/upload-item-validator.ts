/**
 * Validación estructural de un item subido a `POST /documents/upload`
 * (spec 02 v2 — reemplaza el `TourItemDto`/`class-validator` de v1, que
 * asumía un schema fijo de tour). No valida contenido de negocio, solo
 * forma: objeto plano, profundidad de anidamiento y tamaño serializado.
 */

/**
 * `true` si `value` es un objeto JSON "plano" — no `null`, no array, no
 * primitivo. Es la única forma aceptada para un elemento del array subido.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Profundidad de anidamiento de `value` — un objeto/array sin hijos
 * objeto/array anidados tiene profundidad 1; cada nivel adicional de
 * objeto/array anidado dentro de otro objeto/array suma 1. Los valores
 * primitivos no aportan profundidad.
 */
export function calculateDepth(value: unknown): number {
  if (value === null || typeof value !== 'object') {
    return 0;
  }

  const children = Array.isArray(value) ? value : Object.values(value);
  if (children.length === 0) {
    return 1;
  }

  const childDepths = children.map((child) => calculateDepth(child));
  return 1 + Math.max(...childDepths);
}

/**
 * Tamaño en bytes UTF-8 de `value` serializado con `JSON.stringify` — usado
 * para el límite `MAX_ITEM_SIZE_BYTES`.
 */
export function serializedSizeBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf-8');
}

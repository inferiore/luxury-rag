import { Injectable } from '@nestjs/common';
import { ChunksRepository } from './chunks.repository';
import { Chunk } from './entities/chunk.entity';

/**
 * Aplana un objeto JSON arbitrario a texto "clave: valor" recursivo, sin
 * asumir ningún nombre de campo (spec 02 v2 — reemplaza `buildContent`, que
 * asumía el schema fijo de tour). Reglas (ver spec, sección 2):
 * - `null`/`undefined`/string vacío: se omite.
 * - primitivo: `"<claveCompleta>: <valor>."`.
 * - objeto: recursa con `<claveCompleta>` como nuevo prefijo (`a.b`).
 * - array de primitivos: `"<claveCompleta>: <v1>, <v2>, <v3>."`.
 * - array de objetos (o mixto): recursa cada elemento con prefijo
 *   `<claveCompleta>[i]`.
 * El orden de las líneas sigue el orden de `Object.keys` del JSON original.
 */
export function flattenToText(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    flattenValue(key, value, lines);
  }
  return lines.join(' ');
}

function flattenValue(prefix: string, value: unknown, lines: string[]): void {
  if (value === null || value === undefined || value === '') {
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return;
    }

    const allPrimitive = value.every(
      (item) => item === null || typeof item !== 'object',
    );

    if (allPrimitive) {
      const rendered = value
        .filter((item) => item !== null && item !== undefined && item !== '')
        .map((item) => String(item));
      if (rendered.length > 0) {
        lines.push(`${prefix}: ${rendered.join(', ')}.`);
      }
      return;
    }

    value.forEach((item, index) => {
      flattenValue(`${prefix}[${index}]`, item, lines);
    });
    return;
  }

  if (typeof value === 'object') {
    for (const [key, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      flattenValue(`${prefix}.${key}`, childValue, lines);
    }
    return;
  }

  const primitive = value as string | number | boolean;
  lines.push(`${prefix}: ${String(primitive)}.`);
}

@Injectable()
export class ChunksService {
  constructor(private readonly chunksRepository: ChunksRepository) {}

  flattenToText(item: Record<string, unknown>): string {
    return flattenToText(item);
  }

  async createChunk(
    documentId: string,
    item: Record<string, unknown>,
  ): Promise<Chunk> {
    const content = this.flattenToText(item);
    return this.chunksRepository.create({
      documentId,
      rawData: item,
      content,
    });
  }
}

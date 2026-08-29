import { API_BASE_URL, authHeaders } from './config';
import {
  ApiError,
  type ChunkListItemDto,
  type DocumentsErrorResponse,
  type PaginatedResponse,
  type RetryChunkResponse,
} from './types';

/**
 * GET /documents/:id/chunks?page=&limit= — lista paginada de chunks de un documento.
 * Ver rag/specs/08-documentos-chunks-retry.md, contrato 3.
 */
export async function getDocumentChunks(
  documentId: string,
  page: number,
  limit = 20,
): Promise<PaginatedResponse<ChunkListItemDto>> {
  let response: Response;
  try {
    response = await fetch(
      `${API_BASE_URL}/documents/${documentId}/chunks?page=${page}&limit=${limit}`,
      { headers: { ...authHeaders() } },
    );
  } catch {
    throw new ApiError(
      'No se pudo conectar con el servidor. Verifica que el backend esté corriendo.',
      null,
      false,
    );
  }

  if (!response.ok) {
    let backendMessage = `Error ${response.status} al listar los chunks.`;
    try {
      const body = (await response.json()) as DocumentsErrorResponse;
      if (body?.message) backendMessage = body.message;
    } catch {
      // el backend no devolvió JSON parseable; se usa el mensaje genérico de arriba
    }
    throw new ApiError(backendMessage, response.status, true);
  }

  return (await response.json()) as PaginatedResponse<ChunkListItemDto>;
}

/**
 * POST /documents/:documentId/chunks/:chunkId/retry — reintenta un chunk
 * individual en estado `failed`. Ver rag/specs/08-documentos-chunks-retry.md,
 * contrato 4.
 */
export async function retryChunk(
  documentId: string,
  chunkId: string,
): Promise<RetryChunkResponse> {
  let response: Response;
  try {
    response = await fetch(
      `${API_BASE_URL}/documents/${documentId}/chunks/${chunkId}/retry`,
      { method: 'POST', headers: { ...authHeaders() } },
    );
  } catch {
    throw new ApiError(
      'No se pudo conectar con el servidor. Verifica que el backend esté corriendo.',
      null,
      false,
    );
  }

  if (!response.ok) {
    let backendMessage = `Error ${response.status} al reintentar el chunk.`;
    try {
      const body = (await response.json()) as DocumentsErrorResponse;
      if (body?.message) backendMessage = body.message;
    } catch {
      // el backend no devolvió JSON parseable; se usa el mensaje genérico de arriba
    }
    throw new ApiError(backendMessage, response.status, true);
  }

  return (await response.json()) as RetryChunkResponse;
}

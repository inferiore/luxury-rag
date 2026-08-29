import { API_BASE_URL, authHeaders } from './config';
import {
  ApiError,
  type DocumentListItemDto,
  type DocumentsErrorResponse,
  type PaginatedResponse,
  type RetryFailedChunksResponse,
  type UploadErrorResponse,
  type UploadSuccessResponse,
} from './types';

/**
 * POST /documents/upload — multipart/form-data, campo "file".
 * Ver rag/specs/02-upload-y-chunking-job.md para el contrato exacto.
 */
export async function uploadTours(file: File): Promise<UploadSuccessResponse> {
  const formData = new FormData();
  formData.append('file', file);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/documents/upload`, {
      method: 'POST',
      headers: { ...authHeaders() },
      body: formData,
    });
  } catch {
    throw new ApiError(
      'No se pudo conectar con el servidor. Verifica que el backend esté corriendo.',
      null,
      false,
    );
  }

  if (!response.ok) {
    let backendMessage = `Error ${response.status} al subir el archivo.`;
    try {
      const body = (await response.json()) as UploadErrorResponse;
      if (body?.message) backendMessage = body.message;
    } catch {
      // el backend no devolvió JSON parseable; se usa el mensaje genérico de arriba
    }
    throw new ApiError(backendMessage, response.status, true);
  }

  return (await response.json()) as UploadSuccessResponse;
}

/**
 * GET /documents?page=&limit= — lista paginada de documentos.
 * Ver rag/specs/08-documentos-chunks-retry.md, contrato 1.
 */
export async function getDocuments(
  page: number,
  limit = 20,
): Promise<PaginatedResponse<DocumentListItemDto>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/documents?page=${page}&limit=${limit}`, {
      headers: { ...authHeaders() },
    });
  } catch {
    throw new ApiError(
      'No se pudo conectar con el servidor. Verifica que el backend esté corriendo.',
      null,
      false,
    );
  }

  if (!response.ok) {
    let backendMessage = `Error ${response.status} al listar los documentos.`;
    try {
      const body = (await response.json()) as DocumentsErrorResponse;
      if (body?.message) backendMessage = body.message;
    } catch {
      // el backend no devolvió JSON parseable; se usa el mensaje genérico de arriba
    }
    throw new ApiError(backendMessage, response.status, true);
  }

  return (await response.json()) as PaginatedResponse<DocumentListItemDto>;
}

/**
 * GET /documents/:id — detalle de un documento.
 * Ver rag/specs/08-documentos-chunks-retry.md, contrato 2.
 */
export async function getDocument(id: string): Promise<DocumentListItemDto> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/documents/${id}`, {
      headers: { ...authHeaders() },
    });
  } catch {
    throw new ApiError(
      'No se pudo conectar con el servidor. Verifica que el backend esté corriendo.',
      null,
      false,
    );
  }

  if (!response.ok) {
    let backendMessage = `Error ${response.status} al obtener el documento.`;
    try {
      const body = (await response.json()) as DocumentsErrorResponse;
      if (body?.message) backendMessage = body.message;
    } catch {
      // el backend no devolvió JSON parseable; se usa el mensaje genérico de arriba
    }
    throw new ApiError(backendMessage, response.status, true);
  }

  return (await response.json()) as DocumentListItemDto;
}

/**
 * POST /documents/:id/retry-failed-chunks — reintenta todos los chunks
 * `failed` de un documento. Ver rag/specs/08-documentos-chunks-retry.md,
 * contrato 5. El caso límite de 409 (documento sin chunks) se propaga en
 * `error.message` tal cual lo devuelve el backend — la UI lo muestra
 * directamente, no lo hardcodea.
 */
export async function retryFailedChunks(documentId: string): Promise<RetryFailedChunksResponse> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/documents/${documentId}/retry-failed-chunks`, {
      method: 'POST',
      headers: { ...authHeaders() },
    });
  } catch {
    throw new ApiError(
      'No se pudo conectar con el servidor. Verifica que el backend esté corriendo.',
      null,
      false,
    );
  }

  if (!response.ok) {
    let backendMessage = `Error ${response.status} al reintentar los chunks fallidos.`;
    try {
      const body = (await response.json()) as DocumentsErrorResponse;
      if (body?.message) backendMessage = body.message;
    } catch {
      // el backend no devolvió JSON parseable; se usa el mensaje genérico de arriba
    }
    throw new ApiError(backendMessage, response.status, true);
  }

  return (await response.json()) as RetryFailedChunksResponse;
}

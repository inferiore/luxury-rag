import { API_BASE_URL } from './config';
import { ApiError, type QueryErrorResponse, type QueryRequest, type QueryResponse } from './types';

/**
 * POST /query — { question }. topK se deja en el default del backend (no se
 * expone en la UI, ver rag/specs/06-frontend-react.md).
 * Ver rag/specs/04-query-endpoint.md para el contrato exacto.
 */
export async function askQuestion(question: string): Promise<QueryResponse> {
  const payload: QueryRequest = { question };

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new ApiError(
      'No se pudo conectar con el servidor. Verifica que el backend esté corriendo.',
      null,
      false,
    );
  }

  if (!response.ok) {
    let backendMessage = `Error ${response.status} al consultar.`;
    try {
      const body = (await response.json()) as QueryErrorResponse;
      if (body?.message) backendMessage = body.message;
    } catch {
      // el backend no devolvió JSON parseable; se usa el mensaje genérico de arriba
    }
    throw new ApiError(backendMessage, response.status, true);
  }

  return (await response.json()) as QueryResponse;
}

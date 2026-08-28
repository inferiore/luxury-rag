// Tipos que reflejan EXACTAMENTE los contratos de rag/specs/02-upload-y-chunking-job.md
// y rag/specs/04-query-endpoint.md. No agregar campos que el backend no devuelve.

export interface UploadSuccessResponse {
  documentId: string;
  totalItems: number;
  status: string;
}

export interface UploadErrorItem {
  index: number;
  field: string;
  constraint: string;
}

export interface UploadErrorResponse {
  statusCode: number;
  message: string;
  errors?: UploadErrorItem[];
}

export interface QueryRequest {
  question: string;
}

export interface QueryResponse {
  answer: string;
  matched: boolean;
}

export interface QueryErrorResponse {
  statusCode: number;
  message: string;
}

// Tipos que reflejan EXACTAMENTE los contratos de rag/specs/08-documentos-chunks-retry.md
// (sección "Contratos de API"). No agregar campos que el backend no devuelve.

export type DocumentStatus = 'pending' | 'processing' | 'done' | 'failed';
export type ChunkStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface DocumentListItemDto {
  id: string;
  originalFilename: string;
  totalItems: number;
  status: DocumentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ChunkListItemDto {
  id: string;
  documentId: string;
  content: string;
  status: ChunkStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface RetryChunkResponse {
  chunkId: string;
  documentId: string;
  status: ChunkStatus;
}

export interface RetryFailedChunksResponse {
  documentId: string;
  retriedCount: number;
  status: DocumentStatus;
}

export interface DocumentsErrorResponse {
  statusCode: number;
  message: string;
}

/**
 * Error tipado para distinguir "el backend respondió con un error" (400/500 con
 * mensaje del backend) de un fallo de red real (backend caído, timeout, etc.).
 * La UI usa `isBackendError` para decidir si mostrar el `message` del backend
 * tal cual o un mensaje genérico de fallo de conexión.
 */
export class ApiError extends Error {
  readonly status: number | null;
  readonly isBackendError: boolean;

  constructor(message: string, status: number | null, isBackendError: boolean) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.isBackendError = isBackendError;
  }
}

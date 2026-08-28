import { ChunkStatus } from '../../chunks/entities/chunk.entity';

/**
 * Shape expuesto por `GET /documents/:id/chunks`. Nunca incluye `rawData`
 * ni `embedding` (spec 08, sección "Contratos de API", punto 3).
 */
export interface ChunkResponseDto {
  id: string;
  documentId: string;
  content: string;
  status: ChunkStatus;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

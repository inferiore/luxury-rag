export const CHUNK_CREATED_EVENT = 'chunk.created';

export interface ChunkCreatedPayload {
  chunkId: string;
  documentId: string;
}

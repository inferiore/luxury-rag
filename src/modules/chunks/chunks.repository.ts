import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Chunk } from './entities/chunk.entity';

export interface NearestChunk {
  id: string;
  content: string;
  distance: number;
}

export interface CreateChunkInput {
  documentId: string;
  rawData: Record<string, unknown>;
  content: string;
}

@Injectable()
export class ChunksRepository {
  constructor(
    @InjectRepository(Chunk)
    private readonly repository: Repository<Chunk>,
  ) {}

  async create(input: CreateChunkInput): Promise<Chunk> {
    const chunk = this.repository.create({
      documentId: input.documentId,
      rawData: input.rawData,
      content: input.content,
      status: 'pending',
    });
    return this.repository.save(chunk);
  }

  async findById(id: string): Promise<Chunk | null> {
    return this.repository.findOne({ where: { id } });
  }

  async markProcessing(id: string): Promise<void> {
    await this.repository.update(id, { status: 'processing' });
  }

  /**
   * Persiste el embedding generado. La columna `embedding` (tipo `vector`
   * de pgvector) no está mapeada en la entity `Chunk` — TypeORM no tiene un
   * tipo nativo para ella — así que se escribe con SQL raw, tal como decide
   * `00-arquitectura-general.md`. El literal `[v1,v2,...]` que produce
   * `JSON.stringify` de un array de números es el formato de texto que
   * pgvector espera para un cast `::vector`.
   */
  async markEmbeddingDone(id: string, embedding: number[]): Promise<void> {
    await this.repository.query(
      `UPDATE chunks SET embedding = $1::vector, status = $2, error_message = NULL, updated_at = now() WHERE id = $3`,
      [JSON.stringify(embedding), 'done', id],
    );
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    await this.repository.update(id, {
      status: 'failed',
      errorMessage,
    });
  }

  async countUnfinishedByDocumentId(documentId: string): Promise<number> {
    return this.repository.count({
      where: { documentId, status: In(['pending', 'processing']) },
    });
  }

  async countFailedByDocumentId(documentId: string): Promise<number> {
    return this.repository.count({
      where: { documentId, status: 'failed' },
    });
  }

  /**
   * Listado paginado para `GET /documents/:id/chunks` (spec 08) — orden
   * cronológico de creación. Nunca se usa para exponer `rawData`/`embedding`
   * (el mapeo a `ChunkResponseDto` en `DocumentsService` los omite).
   */
  async findByDocumentIdPaginated(
    documentId: string,
    page: number,
    limit: number,
  ): Promise<{ items: Chunk[]; total: number }> {
    const [items, total] = await this.repository.findAndCount({
      where: { documentId },
      order: { createdAt: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total };
  }

  /**
   * IDs de los chunks `failed` de un documento — usados por el retry masivo
   * (spec 08) para saber qué resetear y por cuáles chunks re-emitir
   * `CHUNK_CREATED_EVENT`.
   */
  async findFailedIdsByDocumentId(documentId: string): Promise<string[]> {
    const rows = await this.repository.find({
      where: { documentId, status: 'failed' },
      select: ['id'],
    });
    return rows.map((row) => row.id);
  }

  /**
   * Resetea un chunk `failed` a `pending` limpiando `errorMessage`, previo a
   * re-emitir `CHUNK_CREATED_EVENT` (spec 08). Debe completarse en BD antes
   * de emitir el evento — ver "Diseño técnico" de la spec 08 sobre la
   * condición de carrera con `EmbedChunkListener`.
   */
  async resetToPending(id: string): Promise<void> {
    await this.repository.update(id, {
      status: 'pending',
      errorMessage: null,
    });
  }

  /**
   * Búsqueda por similitud coseno sobre el índice HNSW (`embedding <=>` de
   * pgvector — distancia, 0 = idéntico, mayor = más lejano). Solo considera
   * chunks con `status = 'done'` (embedding ya persistido). SQL raw porque
   * la columna `embedding` no está mapeada en la entity `Chunk`.
   */
  async findNearest(
    embedding: number[],
    topK: number,
  ): Promise<NearestChunk[]> {
    const rows = await this.repository.query<
      { id: string; content: string; distance: string }[]
    >(
      `SELECT id, content, (embedding <=> $1::vector) AS distance
       FROM chunks
       WHERE status = 'done'
       ORDER BY distance ASC
       LIMIT $2`,
      [JSON.stringify(embedding), topK],
    );

    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      distance: parseFloat(row.distance),
    }));
  }
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Document } from './entities/document.entity';

@Injectable()
export class DocumentsRepository {
  constructor(
    @InjectRepository(Document)
    private readonly repository: Repository<Document>,
  ) {}

  async createProcessing(
    originalFilename: string,
    totalItems: number,
  ): Promise<Document> {
    const document = this.repository.create({
      originalFilename,
      totalItems,
      status: 'processing',
    });
    return this.repository.save(document);
  }

  async findById(id: string): Promise<Document | null> {
    return this.repository.findOne({ where: { id } });
  }

  async markDone(id: string): Promise<void> {
    await this.repository.update(id, { status: 'done' });
  }

  async markFailed(id: string): Promise<void> {
    await this.repository.update(id, { status: 'failed' });
  }

  /**
   * Listado paginado para `GET /documents` (spec 08) — más recientes primero.
   */
  async findAllPaginated(
    page: number,
    limit: number,
  ): Promise<{ items: Document[]; total: number }> {
    const [items, total] = await this.repository.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total };
  }

  /**
   * Usado por el flujo de retry (spec 08): al reintentar uno o varios chunks
   * `failed` de un documento, este vuelve a `processing` antes de re-emitir
   * `CHUNK_CREATED_EVENT`.
   */
  async markProcessing(id: string): Promise<void> {
    await this.repository.update(id, { status: 'processing' });
  }
}

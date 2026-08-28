import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { isUUID } from 'class-validator';
import {
  UploadResponseDto,
  UploadValidationErrorItem,
} from './dto/upload-tours.dto';
import {
  calculateDepth,
  isPlainObject,
  serializedSizeBytes,
} from './validation/upload-item-validator';
import { DocumentsRepository } from './documents.repository';
import { ChunksRepository } from '../chunks/chunks.repository';
import { ChunksService } from '../chunks/chunks.service';
import { CHUNK_CREATED_EVENT } from '../chunks/chunks.events';
import { Document } from './entities/document.entity';
import { Chunk } from '../chunks/entities/chunk.entity';
import { PaginatedResponseDto } from './dto/paginated-response.dto';
import { DocumentResponseDto } from './dto/document-response.dto';
import { ChunkResponseDto } from './dto/chunk-response.dto';
import {
  RetryChunkResponseDto,
  RetryFailedChunksResponseDto,
} from './dto/retry-response.dto';

export const DOCUMENT_UPLOADED_EVENT = 'document.uploaded';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface DocumentUploadedPayload {
  documentId: string;
  items: Record<string, unknown>[];
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly configService: ConfigService,
    private readonly documentsRepository: DocumentsRepository,
    private readonly chunksRepository: ChunksRepository,
    private readonly chunksService: ChunksService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async upload(file: Express.Multer.File): Promise<UploadResponseDto> {
    const parsed = this.parseJson(file.buffer);
    const items = this.validateItems(parsed);

    const document = await this.documentsRepository.createProcessing(
      file.originalname,
      items.length,
    );

    const payload: DocumentUploadedPayload = {
      documentId: document.id,
      items,
    };
    this.eventEmitter.emit(DOCUMENT_UPLOADED_EVENT, payload);

    return {
      documentId: document.id,
      totalItems: document.totalItems,
      status: document.status,
    };
  }

  private parseJson(buffer: Buffer): unknown {
    try {
      return JSON.parse(buffer.toString('utf-8'));
    } catch {
      throw new BadRequestException('El archivo no contiene JSON válido');
    }
  }

  /**
   * Validación estructural genérica del array subido (spec 02 v2 — sin
   * schema fijo de negocio). Rechaza el batch completo (mismo
   * comportamiento que v1) si cualquier elemento falla alguna regla,
   * identificando en `errors[]` el índice de cada elemento inválido.
   */
  private validateItems(parsed: unknown): Record<string, unknown>[] {
    if (!Array.isArray(parsed)) {
      throw new BadRequestException(
        'El archivo debe contener un array de elementos',
      );
    }

    if (parsed.length === 0) {
      throw new BadRequestException(
        'El archivo debe contener al menos un elemento',
      );
    }

    const maxItems = this.configService.get<number>('upload.maxItems') ?? 2000;
    if (parsed.length > maxItems) {
      throw new BadRequestException({
        statusCode: 400,
        message: `El archivo contiene ${parsed.length} elementos, el máximo permitido es ${maxItems}`,
      });
    }

    const maxDepth = this.configService.get<number>('upload.maxItemDepth') ?? 6;
    const maxSizeBytes =
      this.configService.get<number>('upload.maxItemSizeBytes') ?? 100000;

    const errors: UploadValidationErrorItem[] = [];
    const items: Record<string, unknown>[] = [];
    let firstMessage: string | null = null;
    const rawItems: unknown[] = parsed;

    for (let index = 0; index < rawItems.length; index++) {
      const candidate: unknown = rawItems[index];

      if (!isPlainObject(candidate)) {
        errors.push({
          index,
          field: 'root',
          constraint:
            'El elemento debe ser un objeto, no array/string/number/null',
        });
        firstMessage ??= `El item en la posición ${index} no es un objeto JSON válido`;
        continue;
      }

      const depth = calculateDepth(candidate);
      if (depth > maxDepth) {
        errors.push({
          index,
          field: 'root',
          constraint: `El elemento excede la profundidad máxima permitida de ${maxDepth} niveles`,
        });
        firstMessage ??= `El item en la posición ${index} excede la profundidad máxima permitida de ${maxDepth} niveles`;
        continue;
      }

      const sizeBytes = serializedSizeBytes(candidate);
      if (sizeBytes > maxSizeBytes) {
        errors.push({
          index,
          field: 'root',
          constraint: `El elemento excede el tamaño máximo permitido de ${maxSizeBytes} bytes`,
        });
        firstMessage ??= `El item en la posición ${index} excede el tamaño máximo permitido de ${maxSizeBytes} bytes`;
        continue;
      }

      const content = this.chunksService.flattenToText(candidate);
      if (content.trim().length === 0) {
        errors.push({
          index,
          field: 'root',
          constraint:
            'El objeto está vacío o todos sus valores son nulos/vacíos',
        });
        firstMessage ??= `El item en la posición ${index} no contiene ningún dato serializable a texto`;
        continue;
      }

      items.push(candidate);
    }

    if (errors.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        message: firstMessage,
        errors,
      });
    }

    return items;
  }

  /**
   * Llamado por `EmbedChunkListener` (modules/embeddings) tras procesar cada
   * chunk. Si ya no quedan chunks `pending`/`processing` para este
   * documento, actualiza `documents.status` a `'done'` (todos los chunks
   * terminaron `'done'`) o `'failed'` (al menos uno terminó `'failed'`).
   */
  async finalizeStatusIfComplete(documentId: string): Promise<void> {
    const unfinished =
      await this.chunksRepository.countUnfinishedByDocumentId(documentId);
    if (unfinished > 0) {
      return;
    }

    const failedCount =
      await this.chunksRepository.countFailedByDocumentId(documentId);

    if (failedCount > 0) {
      await this.documentsRepository.markFailed(documentId);
    } else {
      await this.documentsRepository.markDone(documentId);
    }
  }

  /**
   * `GET /documents` (spec 08) — listado paginado, más recientes primero.
   */
  async listDocuments(
    page?: number,
    limit?: number,
  ): Promise<PaginatedResponseDto<DocumentResponseDto>> {
    const { page: resolvedPage, limit: resolvedLimit } =
      this.resolvePagination(page, limit);
    const { items, total } = await this.documentsRepository.findAllPaginated(
      resolvedPage,
      resolvedLimit,
    );
    return this.toPaginatedResponse(
      items.map((document) => this.toDocumentDto(document)),
      total,
      resolvedPage,
      resolvedLimit,
    );
  }

  /**
   * `GET /documents/:id` (spec 08).
   */
  async getDocumentById(id: string): Promise<DocumentResponseDto> {
    const document = await this.findDocumentOrThrow(id);
    return this.toDocumentDto(document);
  }

  /**
   * `GET /documents/:id/chunks` (spec 08) — nunca incluye `rawData` ni
   * `embedding` en la respuesta.
   */
  async listChunksByDocument(
    documentId: string,
    page?: number,
    limit?: number,
  ): Promise<PaginatedResponseDto<ChunkResponseDto>> {
    await this.findDocumentOrThrow(documentId);

    const { page: resolvedPage, limit: resolvedLimit } =
      this.resolvePagination(page, limit);
    const { items, total } =
      await this.chunksRepository.findByDocumentIdPaginated(
        documentId,
        resolvedPage,
        resolvedLimit,
      );
    return this.toPaginatedResponse(
      items.map((chunk) => this.toChunkDto(chunk)),
      total,
      resolvedPage,
      resolvedLimit,
    );
  }

  /**
   * `POST /documents/:documentId/chunks/:chunkId/retry` (spec 08).
   *
   * El 404 cubre tres casos con el mismo mensaje (documento inexistente,
   * chunk inexistente, o chunk que pertenece a otro documento) — ver
   * "Contratos de API", punto 4 de la spec.
   *
   * Orden de operaciones no opcional: reset en BD (chunk -> pending,
   * documento -> processing) antes de re-emitir `CHUNK_CREATED_EVENT`, para
   * evitar la condición de carrera documentada con `EmbedChunkListener`.
   */
  async retryChunk(
    documentId: string,
    chunkId: string,
  ): Promise<RetryChunkResponseDto> {
    const notFoundMessage = `Chunk ${chunkId} no encontrado para el documento ${documentId}`;

    if (!isUUID(documentId) || !isUUID(chunkId)) {
      throw new NotFoundException(notFoundMessage);
    }

    const document = await this.documentsRepository.findById(documentId);
    if (!document) {
      throw new NotFoundException(notFoundMessage);
    }

    const chunk = await this.chunksRepository.findById(chunkId);
    if (!chunk || chunk.documentId !== documentId) {
      throw new NotFoundException(notFoundMessage);
    }

    if (chunk.status !== 'failed') {
      throw new ConflictException(
        `El chunk ${chunkId} está en estado '${chunk.status}', solo se puede reintentar si está en 'failed'`,
      );
    }

    await this.chunksRepository.resetToPending(chunkId);
    await this.documentsRepository.markProcessing(documentId);

    this.eventEmitter.emit(CHUNK_CREATED_EVENT, { chunkId, documentId });

    return { chunkId, documentId, status: 'pending' };
  }

  /**
   * `POST /documents/:id/retry-failed-chunks` (spec 08). Incluye el caso
   * límite documentado de un documento `failed` con 0 chunks (chunking
   * falló antes de crear el primero) — se responde 409, mismo
   * comportamiento que "sin chunks failed".
   */
  async retryFailedChunks(
    documentId: string,
  ): Promise<RetryFailedChunksResponseDto> {
    await this.findDocumentOrThrow(documentId);

    const failedIds =
      await this.chunksRepository.findFailedIdsByDocumentId(documentId);
    if (failedIds.length === 0) {
      throw new ConflictException(
        `El documento ${documentId} no tiene chunks en estado 'failed' para reintentar`,
      );
    }

    for (const chunkId of failedIds) {
      await this.chunksRepository.resetToPending(chunkId);
    }
    await this.documentsRepository.markProcessing(documentId);

    for (const chunkId of failedIds) {
      this.eventEmitter.emit(CHUNK_CREATED_EVENT, { chunkId, documentId });
    }

    return {
      documentId,
      retriedCount: failedIds.length,
      status: 'processing',
    };
  }

  private async findDocumentOrThrow(id: string): Promise<Document> {
    if (!isUUID(id)) {
      throw new NotFoundException(`Documento ${id} no encontrado`);
    }
    const document = await this.documentsRepository.findById(id);
    if (!document) {
      throw new NotFoundException(`Documento ${id} no encontrado`);
    }
    return document;
  }

  private resolvePagination(
    page?: number,
    limit?: number,
  ): { page: number; limit: number } {
    return {
      page: page ?? DEFAULT_PAGE,
      limit: Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT),
    };
  }

  private toPaginatedResponse<T>(
    items: T[],
    total: number,
    page: number,
    limit: number,
  ): PaginatedResponseDto<T> {
    return {
      items,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  private toDocumentDto(document: Document): DocumentResponseDto {
    return {
      id: document.id,
      originalFilename: document.originalFilename,
      totalItems: document.totalItems,
      status: document.status,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  }

  private toChunkDto(chunk: Chunk): ChunkResponseDto {
    return {
      id: chunk.id,
      documentId: chunk.documentId,
      content: chunk.content,
      status: chunk.status,
      errorMessage: chunk.errorMessage,
      createdAt: chunk.createdAt,
      updatedAt: chunk.updatedAt,
    };
  }
}

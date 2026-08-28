import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { DOCUMENT_UPLOADED_EVENT, DocumentsService } from './documents.service';
import { DocumentsRepository } from './documents.repository';
import { ChunksRepository } from '../chunks/chunks.repository';
import { ChunksService } from '../chunks/chunks.service';

describe('DocumentsService', () => {
  let service: DocumentsService;
  let repository: jest.Mocked<DocumentsRepository>;
  let chunksRepository: jest.Mocked<ChunksRepository>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  const buildFile = (content: unknown): Express.Multer.File =>
    ({
      originalname: 'items.json',
      buffer: Buffer.from(JSON.stringify(content)),
    }) as Express.Multer.File;

  const defaultLimits: Record<string, number> = {
    'upload.maxItems': 2000,
    'upload.maxItemDepth': 6,
    'upload.maxItemSizeBytes': 100000,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentsService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => defaultLimits[key]),
          },
        },
        {
          provide: DocumentsRepository,
          useValue: {
            createProcessing: jest.fn(),
            findById: jest.fn(),
            markDone: jest.fn(),
            markFailed: jest.fn(),
            findAllPaginated: jest.fn(),
            markProcessing: jest.fn(),
          },
        },
        {
          provide: ChunksRepository,
          useValue: {
            countUnfinishedByDocumentId: jest.fn(),
            countFailedByDocumentId: jest.fn(),
            findByDocumentIdPaginated: jest.fn(),
            findFailedIdsByDocumentId: jest.fn(),
            resetToPending: jest.fn(),
            findById: jest.fn(),
          },
        },
        {
          provide: ChunksService,
          useValue: {
            flattenToText: jest.fn((item: Record<string, unknown>) =>
              Object.entries(item)
                .filter(([, v]) => v !== null && v !== undefined && v !== '')
                .map(([k, v]) => `${k}: ${String(v)}.`)
                .join(' '),
            ),
          },
        },
        {
          provide: EventEmitter2,
          useValue: { emit: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(DocumentsService);
    repository = module.get(DocumentsRepository);
    chunksRepository = module.get(ChunksRepository);
    eventEmitter = module.get(EventEmitter2);
  });

  it('rechaza un archivo que no es JSON válido', async () => {
    const file = {
      originalname: 'items.json',
      buffer: Buffer.from('{ esto no es json'),
    } as Express.Multer.File;

    await expect(service.upload(file)).rejects.toThrow(BadRequestException);
    expect(repository.createProcessing).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('rechaza un JSON que no es un array', async () => {
    const file = buildFile({ nombre: 'Tour suelto' });

    await expect(service.upload(file)).rejects.toThrow(BadRequestException);
    expect(repository.createProcessing).not.toHaveBeenCalled();
  });

  it('rechaza un array vacío', async () => {
    const file = buildFile([]);

    await expect(service.upload(file)).rejects.toThrow(BadRequestException);
    expect(repository.createProcessing).not.toHaveBeenCalled();
  });

  it('rechaza el batch completo si un elemento no es un objeto (string/number/array)', async () => {
    const file = buildFile(['a', { x: 1 }]);

    await expect(service.upload(file)).rejects.toThrow(BadRequestException);
    expect(repository.createProcessing).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('rechaza el batch completo si un elemento es un objeto vacío', async () => {
    const file = buildFile([{ nombre: 'Tour válido' }, {}]);

    await expect(service.upload(file)).rejects.toThrow(BadRequestException);
    expect(repository.createProcessing).not.toHaveBeenCalled();
  });

  it('rechaza un elemento que excede la profundidad máxima', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentsService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(
              (key: string) =>
                ({ ...defaultLimits, 'upload.maxItemDepth': 2 })[key],
            ),
          },
        },
        {
          provide: DocumentsRepository,
          useValue: { createProcessing: jest.fn() },
        },
        {
          provide: ChunksRepository,
          useValue: {},
        },
        {
          provide: ChunksService,
          useValue: { flattenToText: jest.fn(() => 'a: 1.') },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    const deepService = module.get(DocumentsService);
    const deepRepository = module.get(DocumentsRepository);

    const file = buildFile([{ a: { b: { c: 1 } } }]);

    await expect(deepService.upload(file)).rejects.toThrow(BadRequestException);
    expect(deepRepository.createProcessing).not.toHaveBeenCalled();
  });

  it('rechaza un elemento que excede el tamaño máximo serializado', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentsService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(
              (key: string) =>
                ({ ...defaultLimits, 'upload.maxItemSizeBytes': 10 })[key],
            ),
          },
        },
        {
          provide: DocumentsRepository,
          useValue: { createProcessing: jest.fn() },
        },
        { provide: ChunksRepository, useValue: {} },
        {
          provide: ChunksService,
          useValue: { flattenToText: jest.fn(() => 'a: 1.') },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    const smallService = module.get(DocumentsService);
    const smallRepository = module.get(DocumentsRepository);

    const file = buildFile([
      { nombre: 'un texto bastante largo para superar 10 bytes' },
    ]);

    await expect(smallService.upload(file)).rejects.toThrow(
      BadRequestException,
    );
    expect(smallRepository.createProcessing).not.toHaveBeenCalled();
  });

  it('rechaza un array con más elementos que MAX_UPLOAD_ITEMS', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentsService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(
              (key: string) =>
                ({ ...defaultLimits, 'upload.maxItems': 1 })[key],
            ),
          },
        },
        {
          provide: DocumentsRepository,
          useValue: { createProcessing: jest.fn() },
        },
        { provide: ChunksRepository, useValue: {} },
        {
          provide: ChunksService,
          useValue: { flattenToText: jest.fn(() => 'a: 1.') },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    const limitedService = module.get(DocumentsService);
    const limitedRepository = module.get(DocumentsRepository);

    const file = buildFile([{ a: 1 }, { a: 2 }]);

    await expect(limitedService.upload(file)).rejects.toThrow(
      BadRequestException,
    );
    expect(limitedRepository.createProcessing).not.toHaveBeenCalled();
  });

  it('crea el documento y emite document.uploaded cuando el batch es válido (schema de tour)', async () => {
    const items = [
      { nombre: 'Tour Guatapé', precio_publico: 180000 },
      { nombre: 'Tour Comuna 13', precio_publico: 90000 },
    ];
    const file = buildFile(items);

    repository.createProcessing.mockResolvedValue({
      id: 'doc-uuid',
      originalFilename: 'items.json',
      totalItems: 2,
      status: 'processing',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.upload(file);

    expect(repository.createProcessing).toHaveBeenCalledWith('items.json', 2);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      DOCUMENT_UPLOADED_EVENT,
      expect.objectContaining({
        documentId: 'doc-uuid',
        items: expect.arrayContaining([
          expect.objectContaining({ nombre: 'Tour Guatapé' }),
        ]),
      }),
    );
    expect(result).toEqual({
      documentId: 'doc-uuid',
      totalItems: 2,
      status: 'processing',
    });
  });

  it('crea el documento y emite document.uploaded para un schema completamente distinto', async () => {
    const items = [
      {
        sku: 'ABC-123',
        titulo: 'Silla ergonómica',
        precio: 450000,
        specs: { color: 'negro' },
      },
      { sku: 'XYZ-9', titulo: 'Escritorio', precio: 900000 },
    ];
    const file = buildFile(items);

    repository.createProcessing.mockResolvedValue({
      id: 'doc-uuid',
      originalFilename: 'items.json',
      totalItems: 2,
      status: 'processing',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.upload(file);

    expect(repository.createProcessing).toHaveBeenCalledWith('items.json', 2);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      DOCUMENT_UPLOADED_EVENT,
      expect.objectContaining({
        documentId: 'doc-uuid',
        items: expect.arrayContaining([
          expect.objectContaining({ sku: 'ABC-123' }),
        ]),
      }),
    );
    expect(result.totalItems).toBe(2);
  });

  describe('finalizeStatusIfComplete', () => {
    it('no hace nada si quedan chunks pending/processing', async () => {
      chunksRepository.countUnfinishedByDocumentId.mockResolvedValue(1);

      await service.finalizeStatusIfComplete('doc-uuid');

      expect(chunksRepository.countFailedByDocumentId).not.toHaveBeenCalled();
      expect(repository.markDone).not.toHaveBeenCalled();
      expect(repository.markFailed).not.toHaveBeenCalled();
    });

    it('marca el documento como done si todos los chunks terminaron sin fallos', async () => {
      chunksRepository.countUnfinishedByDocumentId.mockResolvedValue(0);
      chunksRepository.countFailedByDocumentId.mockResolvedValue(0);

      await service.finalizeStatusIfComplete('doc-uuid');

      expect(repository.markDone).toHaveBeenCalledWith('doc-uuid');
      expect(repository.markFailed).not.toHaveBeenCalled();
    });

    it('marca el documento como failed si al menos un chunk falló', async () => {
      chunksRepository.countUnfinishedByDocumentId.mockResolvedValue(0);
      chunksRepository.countFailedByDocumentId.mockResolvedValue(1);

      await service.finalizeStatusIfComplete('doc-uuid');

      expect(repository.markFailed).toHaveBeenCalledWith('doc-uuid');
      expect(repository.markDone).not.toHaveBeenCalled();
    });
  });

  const docUuid = 'b3f1c2a0-1111-4a2b-9c3d-000000000001';
  const otherDocUuid = 'b3f1c2a0-1111-4a2b-9c3d-000000000002';
  const chunkUuid = 'c1a2b3c4-2222-4a2b-9c3d-000000000001';
  const missingUuid = '00000000-0000-0000-0000-000000000000';

  const buildDocument = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: docUuid,
    originalFilename: 'items.json',
    totalItems: 2,
    status: 'done',
    createdAt: new Date('2026-08-27T14:00:00.000Z'),
    updatedAt: new Date('2026-08-27T14:00:32.000Z'),
    ...overrides,
  });

  const buildChunk = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: chunkUuid,
    documentId: docUuid,
    rawData: { sku: 'ABC-123' },
    content: 'sku: ABC-123.',
    status: 'failed',
    errorMessage: 'Timeout al llamar a Ollama',
    createdAt: new Date('2026-08-27T13:50:01.000Z'),
    updatedAt: new Date('2026-08-27T13:50:11.000Z'),
    ...overrides,
  });

  describe('listDocuments', () => {
    it('pagina con los defaults page=1/limit=20 y recorta limit>100 en silencio', async () => {
      repository.findAllPaginated.mockResolvedValue({
        items: [buildDocument()],
        total: 1,
      });

      const result = await service.listDocuments(undefined, 500);

      expect(repository.findAllPaginated).toHaveBeenCalledWith(1, 100);
      expect(result).toEqual({
        items: [
          {
            id: docUuid,
            originalFilename: 'items.json',
            totalItems: 2,
            status: 'done',
            createdAt: buildDocument().createdAt,
            updatedAt: buildDocument().updatedAt,
          },
        ],
        page: 1,
        limit: 100,
        total: 1,
        totalPages: 1,
      });
    });
  });

  describe('getDocumentById', () => {
    it('devuelve el documento cuando existe', async () => {
      repository.findById.mockResolvedValue(buildDocument() as any);

      const result = await service.getDocumentById(docUuid);

      expect(result.id).toBe(docUuid);
    });

    it('lanza NotFoundException si el documento no existe', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.getDocumentById(missingUuid)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lanza NotFoundException si el id no es un UUID válido', async () => {
      await expect(service.getDocumentById('no-es-uuid')).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.findById).not.toHaveBeenCalled();
    });
  });

  describe('listChunksByDocument', () => {
    it('lanza 404 si el documento no existe', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.listChunksByDocument(missingUuid),
      ).rejects.toThrow(NotFoundException);
      expect(chunksRepository.findByDocumentIdPaginated).not.toHaveBeenCalled();
    });

    it('devuelve los chunks paginados sin rawData ni embedding', async () => {
      repository.findById.mockResolvedValue(buildDocument() as any);
      chunksRepository.findByDocumentIdPaginated.mockResolvedValue({
        items: [buildChunk()],
        total: 1,
      });

      const result = await service.listChunksByDocument(docUuid, 1, 20);

      expect(result.items).toEqual([
        {
          id: chunkUuid,
          documentId: docUuid,
          content: 'sku: ABC-123.',
          status: 'failed',
          errorMessage: 'Timeout al llamar a Ollama',
          createdAt: buildChunk().createdAt,
          updatedAt: buildChunk().updatedAt,
        },
      ]);
      expect(result.items[0]).not.toHaveProperty('rawData');
      expect(result.items[0]).not.toHaveProperty('embedding');
    });
  });

  describe('retryChunk', () => {
    it('resetea el chunk y el documento en BD antes de emitir CHUNK_CREATED_EVENT, y responde 202', async () => {
      repository.findById.mockResolvedValue(buildDocument() as any);
      chunksRepository.findById.mockResolvedValue(buildChunk() as any);

      const result = await service.retryChunk(docUuid, chunkUuid);

      expect(chunksRepository.resetToPending).toHaveBeenCalledWith(chunkUuid);
      expect(repository.markProcessing).toHaveBeenCalledWith(docUuid);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'chunk.created',
        expect.objectContaining({ chunkId: chunkUuid, documentId: docUuid }),
      );
      expect(result).toEqual({
        chunkId: chunkUuid,
        documentId: docUuid,
        status: 'pending',
      });

      const resetOrder = (chunksRepository.resetToPending as jest.Mock).mock
        .invocationCallOrder[0];
      const emitOrder = (eventEmitter.emit as jest.Mock).mock
        .invocationCallOrder[0];
      expect(resetOrder).toBeLessThan(emitOrder);
    });

    it('lanza 404 si el documento no existe', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.retryChunk(missingUuid, chunkUuid)).rejects.toThrow(
        NotFoundException,
      );
      expect(chunksRepository.resetToPending).not.toHaveBeenCalled();
    });

    it('lanza 404 si el chunk no existe', async () => {
      repository.findById.mockResolvedValue(buildDocument() as any);
      chunksRepository.findById.mockResolvedValue(null);

      await expect(service.retryChunk(docUuid, missingUuid)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lanza 404 si el chunk pertenece a otro documento', async () => {
      repository.findById.mockResolvedValue(buildDocument() as any);
      chunksRepository.findById.mockResolvedValue(
        buildChunk({ documentId: otherDocUuid }) as any,
      );

      await expect(service.retryChunk(docUuid, chunkUuid)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lanza 409 si el chunk no está en failed', async () => {
      repository.findById.mockResolvedValue(buildDocument() as any);
      chunksRepository.findById.mockResolvedValue(
        buildChunk({ status: 'done' }) as any,
      );

      await expect(service.retryChunk(docUuid, chunkUuid)).rejects.toThrow(
        ConflictException,
      );
      expect(chunksRepository.resetToPending).not.toHaveBeenCalled();
    });
  });

  describe('retryFailedChunks', () => {
    it('resetea todos los chunks failed y el documento una sola vez, luego emite un evento por chunk', async () => {
      repository.findById.mockResolvedValue(buildDocument() as any);
      chunksRepository.findFailedIdsByDocumentId.mockResolvedValue([
        'chunk-1',
        'chunk-2',
      ]);

      const result = await service.retryFailedChunks(docUuid);

      expect(chunksRepository.resetToPending).toHaveBeenCalledWith('chunk-1');
      expect(chunksRepository.resetToPending).toHaveBeenCalledWith('chunk-2');
      expect(repository.markProcessing).toHaveBeenCalledTimes(1);
      expect(repository.markProcessing).toHaveBeenCalledWith(docUuid);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'chunk.created',
        expect.objectContaining({ chunkId: 'chunk-1', documentId: docUuid }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'chunk.created',
        expect.objectContaining({ chunkId: 'chunk-2', documentId: docUuid }),
      );
      expect(result).toEqual({
        documentId: docUuid,
        retriedCount: 2,
        status: 'processing',
      });
    });

    it('lanza 404 si el documento no existe', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.retryFailedChunks(missingUuid)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lanza 409 si el documento no tiene chunks failed (incluye el caso de 0 chunks totales)', async () => {
      repository.findById.mockResolvedValue(buildDocument() as any);
      chunksRepository.findFailedIdsByDocumentId.mockResolvedValue([]);

      await expect(service.retryFailedChunks(docUuid)).rejects.toThrow(
        ConflictException,
      );
      expect(repository.markProcessing).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});

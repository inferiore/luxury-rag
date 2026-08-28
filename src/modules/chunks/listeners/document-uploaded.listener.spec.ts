import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { DocumentUploadedListener } from './document-uploaded.listener';
import { ChunksService } from '../chunks.service';
import { JobsService } from '../../jobs/jobs.service';
import { CHUNK_CREATED_EVENT } from '../chunks.events';

describe('DocumentUploadedListener', () => {
  let listener: DocumentUploadedListener;
  let chunksService: jest.Mocked<ChunksService>;
  let jobsService: jest.Mocked<JobsService>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentUploadedListener,
        {
          provide: ChunksService,
          useValue: { createChunk: jest.fn() },
        },
        {
          provide: JobsService,
          useValue: {
            startJob: jest.fn(),
            markDone: jest.fn(),
            markFailed: jest.fn(),
          },
        },
        {
          provide: EventEmitter2,
          useValue: { emit: jest.fn() },
        },
      ],
    }).compile();

    listener = module.get(DocumentUploadedListener);
    chunksService = module.get(ChunksService);
    jobsService = module.get(JobsService);
    eventEmitter = module.get(EventEmitter2);
  });

  it('crea un chunk por item, emite chunk.created por cada uno y marca el job como done', async () => {
    jobsService.startJob.mockResolvedValue({ id: 'job-uuid' } as any);
    chunksService.createChunk
      .mockResolvedValueOnce({ id: 'chunk-1' } as any)
      .mockResolvedValueOnce({ id: 'chunk-2' } as any);

    await listener.handleDocumentUploaded({
      documentId: 'doc-uuid',
      items: [{ nombre: 'Tour A' }, { nombre: 'Tour B' }],
    });

    expect(jobsService.startJob).toHaveBeenCalledWith('doc-uuid', 'chunking');
    expect(chunksService.createChunk).toHaveBeenCalledTimes(2);
    expect(eventEmitter.emit).toHaveBeenCalledWith(CHUNK_CREATED_EVENT, {
      chunkId: 'chunk-1',
      documentId: 'doc-uuid',
    });
    expect(eventEmitter.emit).toHaveBeenCalledWith(CHUNK_CREATED_EVENT, {
      chunkId: 'chunk-2',
      documentId: 'doc-uuid',
    });
    expect(jobsService.markDone).toHaveBeenCalledWith('job-uuid');
    expect(jobsService.markFailed).not.toHaveBeenCalled();
  });

  it('marca el job como failed y detiene el procesamiento si un chunk falla', async () => {
    jobsService.startJob.mockResolvedValue({ id: 'job-uuid' } as any);
    chunksService.createChunk.mockRejectedValueOnce(new Error('db error'));

    await listener.handleDocumentUploaded({
      documentId: 'doc-uuid',
      items: [{ nombre: 'Tour A' }],
    });

    expect(jobsService.markFailed).toHaveBeenCalledWith('job-uuid', 'db error');
    expect(jobsService.markDone).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });
});

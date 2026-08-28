import { Test, TestingModule } from '@nestjs/testing';
import { EmbedChunkListener } from './embed-chunk.listener';
import { EmbeddingsService } from '../embeddings.service';
import { JobsService } from '../../jobs/jobs.service';
import { DocumentsService } from '../../documents/documents.service';

describe('EmbedChunkListener', () => {
  let listener: EmbedChunkListener;
  let embeddingsService: jest.Mocked<EmbeddingsService>;
  let jobsService: jest.Mocked<JobsService>;
  let documentsService: jest.Mocked<DocumentsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmbedChunkListener,
        {
          provide: EmbeddingsService,
          useValue: { embedChunk: jest.fn() },
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
          provide: DocumentsService,
          useValue: { finalizeStatusIfComplete: jest.fn() },
        },
      ],
    }).compile();

    listener = module.get(EmbedChunkListener);
    embeddingsService = module.get(EmbeddingsService);
    jobsService = module.get(JobsService);
    documentsService = module.get(DocumentsService);
  });

  it('crea el job de embedding, lo marca done si el embedding tiene éxito y finaliza el estado del documento', async () => {
    jobsService.startJob.mockResolvedValue({ id: 'job-uuid' } as any);
    embeddingsService.embedChunk.mockResolvedValue(undefined);

    await listener.handleChunkCreated({
      chunkId: 'chunk-uuid',
      documentId: 'doc-uuid',
    });

    expect(jobsService.startJob).toHaveBeenCalledWith(
      'doc-uuid',
      'embedding',
      'chunk-uuid',
    );
    expect(embeddingsService.embedChunk).toHaveBeenCalledWith('chunk-uuid');
    expect(jobsService.markDone).toHaveBeenCalledWith('job-uuid');
    expect(jobsService.markFailed).not.toHaveBeenCalled();
    expect(documentsService.finalizeStatusIfComplete).toHaveBeenCalledWith(
      'doc-uuid',
    );
  });

  it('marca el job como failed y aun así finaliza el estado del documento si el embedding falla', async () => {
    jobsService.startJob.mockResolvedValue({ id: 'job-uuid' } as any);
    embeddingsService.embedChunk.mockRejectedValue(new Error('Ollama caído'));

    await listener.handleChunkCreated({
      chunkId: 'chunk-uuid',
      documentId: 'doc-uuid',
    });

    expect(jobsService.markFailed).toHaveBeenCalledWith(
      'job-uuid',
      'Ollama caído',
    );
    expect(jobsService.markDone).not.toHaveBeenCalled();
    expect(documentsService.finalizeStatusIfComplete).toHaveBeenCalledWith(
      'doc-uuid',
    );
  });
});

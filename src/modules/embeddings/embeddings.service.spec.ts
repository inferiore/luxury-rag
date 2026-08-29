import { Test, TestingModule } from '@nestjs/testing';
import { EmbeddingsService } from './embeddings.service';
import { ChunksRepository } from '../chunks/chunks.repository';
import { LLM_PROVIDER_TOKEN, LlmProvider } from '../llm/llm-provider';

describe('EmbeddingsService', () => {
  let service: EmbeddingsService;
  let chunksRepository: jest.Mocked<ChunksRepository>;
  let llmProvider: jest.Mocked<LlmProvider>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmbeddingsService,
        {
          provide: ChunksRepository,
          useValue: {
            findById: jest.fn(),
            markProcessing: jest.fn(),
            markEmbeddingDone: jest.fn(),
            markFailed: jest.fn(),
          },
        },
        {
          provide: LLM_PROVIDER_TOKEN,
          useValue: { embed: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(EmbeddingsService);
    chunksRepository = module.get(ChunksRepository);
    llmProvider = module.get(LLM_PROVIDER_TOKEN);
  });

  it('lanza un error si el chunk no existe', async () => {
    chunksRepository.findById.mockResolvedValue(null);

    await expect(service.embedChunk('chunk-uuid')).rejects.toThrow(
      /no encontrado/,
    );
    expect(chunksRepository.markProcessing).not.toHaveBeenCalled();
  });

  it('marca processing, genera el embedding y lo persiste como done', async () => {
    chunksRepository.findById.mockResolvedValue({
      id: 'chunk-uuid',
      content: 'Tour: Guatapé.',
    } as any);
    const embedding = [0.1, 0.2, 0.3];
    llmProvider.embed.mockResolvedValue(embedding);

    await service.embedChunk('chunk-uuid');

    expect(chunksRepository.markProcessing).toHaveBeenCalledWith('chunk-uuid');
    expect(llmProvider.embed).toHaveBeenCalledWith('Tour: Guatapé.');
    expect(chunksRepository.markEmbeddingDone).toHaveBeenCalledWith(
      'chunk-uuid',
      embedding,
    );
    expect(chunksRepository.markFailed).not.toHaveBeenCalled();
  });

  it('marca failed con el mensaje de error y propaga la excepción si Ollama falla', async () => {
    chunksRepository.findById.mockResolvedValue({
      id: 'chunk-uuid',
      content: 'Tour: Guatapé.',
    } as any);
    llmProvider.embed.mockRejectedValue(new Error('Ollama caído'));

    await expect(service.embedChunk('chunk-uuid')).rejects.toThrow(
      'Ollama caído',
    );
    expect(chunksRepository.markFailed).toHaveBeenCalledWith(
      'chunk-uuid',
      'Ollama caído',
    );
    expect(chunksRepository.markEmbeddingDone).not.toHaveBeenCalled();
  });
});

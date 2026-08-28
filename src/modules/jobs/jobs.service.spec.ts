import { Test, TestingModule } from '@nestjs/testing';
import { JobsService } from './jobs.service';
import { JobsRepository } from './jobs.repository';

describe('JobsService', () => {
  let service: JobsService;
  let repository: jest.Mocked<JobsRepository>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobsService,
        {
          provide: JobsRepository,
          useValue: {
            createProcessing: jest.fn(),
            markDone: jest.fn(),
            markFailed: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(JobsService);
    repository = module.get(JobsRepository);
  });

  it('startJob delega en el repository con jobType y chunkId', async () => {
    repository.createProcessing.mockResolvedValue({ id: 'job-uuid' } as any);

    const job = await service.startJob('doc-uuid', 'chunking');

    expect(repository.createProcessing).toHaveBeenCalledWith(
      'doc-uuid',
      'chunking',
      null,
    );
    expect(job).toEqual({ id: 'job-uuid' });
  });

  it('markDone delega en el repository', async () => {
    await service.markDone('job-uuid');
    expect(repository.markDone).toHaveBeenCalledWith('job-uuid');
  });

  it('markFailed delega en el repository con el mensaje de error', async () => {
    await service.markFailed('job-uuid', 'boom');
    expect(repository.markFailed).toHaveBeenCalledWith('job-uuid', 'boom');
  });
});

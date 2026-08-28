import { Injectable } from '@nestjs/common';
import { JobsRepository } from './jobs.repository';
import { Job, JobType } from './entities/job.entity';

@Injectable()
export class JobsService {
  constructor(private readonly jobsRepository: JobsRepository) {}

  async startJob(
    documentId: string,
    jobType: JobType,
    chunkId: string | null = null,
  ): Promise<Job> {
    return this.jobsRepository.createProcessing(documentId, jobType, chunkId);
  }

  async markDone(jobId: string): Promise<void> {
    await this.jobsRepository.markDone(jobId);
  }

  async markFailed(jobId: string, errorMessage: string): Promise<void> {
    await this.jobsRepository.markFailed(jobId, errorMessage);
  }
}

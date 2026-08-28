import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job, JobType } from './entities/job.entity';

@Injectable()
export class JobsRepository {
  constructor(
    @InjectRepository(Job)
    private readonly repository: Repository<Job>,
  ) {}

  async createProcessing(
    documentId: string,
    jobType: JobType,
    chunkId: string | null = null,
  ): Promise<Job> {
    const job = this.repository.create({
      documentId,
      chunkId,
      jobType,
      status: 'processing',
      startedAt: new Date(),
    });
    return this.repository.save(job);
  }

  async markDone(id: string): Promise<void> {
    await this.repository.update(id, {
      status: 'done',
      finishedAt: new Date(),
    });
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    await this.repository.update(id, {
      status: 'failed',
      errorMessage,
      finishedAt: new Date(),
    });
  }
}

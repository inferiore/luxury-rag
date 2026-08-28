import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type JobType = 'chunking' | 'embedding';
export type JobStatus = 'pending' | 'processing' | 'done' | 'failed';

@Entity({ name: 'job_status' })
export class Job {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'document_id', type: 'uuid' })
  documentId: string;

  @Column({ name: 'chunk_id', type: 'uuid', nullable: true })
  chunkId: string | null;

  @Column({ name: 'job_type', type: 'varchar', length: 20 })
  jobType: JobType;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: JobStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

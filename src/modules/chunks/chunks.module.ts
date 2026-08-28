import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Chunk } from './entities/chunk.entity';
import { ChunksService } from './chunks.service';
import { ChunksRepository } from './chunks.repository';
import { DocumentUploadedListener } from './listeners/document-uploaded.listener';
import { JobsModule } from '../jobs/jobs.module';

@Module({
  imports: [TypeOrmModule.forFeature([Chunk]), JobsModule],
  providers: [ChunksService, ChunksRepository, DocumentUploadedListener],
  exports: [ChunksService, ChunksRepository],
})
export class ChunksModule {}

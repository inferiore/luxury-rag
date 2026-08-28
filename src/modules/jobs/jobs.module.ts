import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job } from './entities/job.entity';
import { JobsService } from './jobs.service';
import { JobsRepository } from './jobs.repository';

@Module({
  imports: [TypeOrmModule.forFeature([Job])],
  providers: [JobsService, JobsRepository],
  exports: [JobsService],
})
export class JobsModule {}

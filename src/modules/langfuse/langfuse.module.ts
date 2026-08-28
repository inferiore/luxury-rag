import { Module } from '@nestjs/common';
import { LangfuseService } from './langfuse.service';

@Module({
  providers: [LangfuseService],
  exports: [LangfuseService],
})
export class LangfuseModule {}

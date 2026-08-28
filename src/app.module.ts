import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { buildTypeOrmOptions } from './database/typeorm.config';
import { DocumentsModule } from './modules/documents/documents.module';
import { ChunksModule } from './modules/chunks/chunks.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { OllamaModule } from './modules/ollama/ollama.module';
import { EmbeddingsModule } from './modules/embeddings/embeddings.module';
import { QueryModule } from './modules/query/query.module';
import { LangfuseModule } from './modules/langfuse/langfuse.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: buildTypeOrmOptions,
    }),
    EventEmitterModule.forRoot(),
    DocumentsModule,
    ChunksModule,
    JobsModule,
    OllamaModule,
    EmbeddingsModule,
    QueryModule,
    LangfuseModule,
    HealthModule,
  ],
})
export class AppModule {}

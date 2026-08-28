import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Document } from './entities/document.entity';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentsRepository } from './documents.repository';
import { ChunksModule } from '../chunks/chunks.module';

@Module({
  imports: [TypeOrmModule.forFeature([Document]), ChunksModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentsRepository],
  exports: [DocumentsRepository, DocumentsService],
})
export class DocumentsModule {}

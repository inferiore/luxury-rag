import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentsService } from './documents.service';
import { UploadResponseDto } from './dto/upload-tours.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import { PaginatedResponseDto } from './dto/paginated-response.dto';
import { DocumentResponseDto } from './dto/document-response.dto';
import { ChunkResponseDto } from './dto/chunk-response.dto';
import {
  RetryChunkResponseDto,
  RetryFailedChunksResponseDto,
} from './dto/retry-response.dto';
import { RateLimit } from '../auth/decorators/rate-limit.decorator';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('upload')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_FILE_SIZE_BYTES },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
  ): Promise<UploadResponseDto> {
    if (!file) {
      throw new BadRequestException("El campo 'file' es requerido");
    }
    return this.documentsService.upload(file);
  }

  @Get()
  async list(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<DocumentResponseDto>> {
    return this.documentsService.listDocuments(query.page, query.limit);
  }

  @Get(':id')
  async getById(@Param('id') id: string): Promise<DocumentResponseDto> {
    return this.documentsService.getDocumentById(id);
  }

  @Get(':id/chunks')
  async listChunks(
    @Param('id') id: string,
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<ChunkResponseDto>> {
    return this.documentsService.listChunksByDocument(
      id,
      query.page,
      query.limit,
    );
  }

  @Post(':documentId/chunks/:chunkId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  async retryChunk(
    @Param('documentId') documentId: string,
    @Param('chunkId') chunkId: string,
  ): Promise<RetryChunkResponseDto> {
    return this.documentsService.retryChunk(documentId, chunkId);
  }

  @Post(':id/retry-failed-chunks')
  @HttpCode(HttpStatus.ACCEPTED)
  async retryFailedChunks(
    @Param('id') id: string,
  ): Promise<RetryFailedChunksResponseDto> {
    return this.documentsService.retryFailedChunks(id);
  }
}

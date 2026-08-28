import { DocumentStatus } from '../entities/document.entity';

export interface DocumentResponseDto {
  id: string;
  originalFilename: string;
  totalItems: number;
  status: DocumentStatus;
  createdAt: Date;
  updatedAt: Date;
}

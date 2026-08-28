export interface UploadValidationErrorItem {
  index: number;
  field: string;
  constraint: string;
}

export interface UploadResponseDto {
  documentId: string;
  totalItems: number;
  status: string;
}

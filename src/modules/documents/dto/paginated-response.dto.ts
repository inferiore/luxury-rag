export interface PaginatedResponseDto<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

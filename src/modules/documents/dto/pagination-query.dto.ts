import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive } from 'class-validator';

/**
 * Query params compartidos por los endpoints de listado paginado
 * (`GET /documents`, `GET /documents/:id/chunks`). El tope de `limit` (100)
 * no se valida aquí — se aplica en `DocumentsService` recortando en
 * silencio, tal como decide la spec 08 (un `limit` fuera de rango no es un
 * error de integridad, es solo un límite de presentación).
 */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  limit?: number;
}

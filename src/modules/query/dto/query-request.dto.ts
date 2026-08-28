import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

export class QueryRequestDto {
  @IsString()
  @IsNotEmpty({ message: 'question no puede estar vacío' })
  question: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  topK?: number;
}

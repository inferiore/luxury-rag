import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { QueryService } from './query.service';
import { QueryRequestDto } from './dto/query-request.dto';
import { QueryResponseDto } from './dto/query-response.dto';

@Controller('query')
export class QueryController {
  constructor(private readonly queryService: QueryService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async ask(@Body() dto: QueryRequestDto): Promise<QueryResponseDto> {
    return this.queryService.ask(dto.question, dto.topK);
  }
}

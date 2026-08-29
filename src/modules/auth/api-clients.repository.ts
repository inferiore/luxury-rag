import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiClient } from './entities/api-client.entity';

@Injectable()
export class ApiClientsRepository {
  constructor(
    @InjectRepository(ApiClient)
    private readonly repository: Repository<ApiClient>,
  ) {}

  async findByKeyHash(apiKeyHash: string): Promise<ApiClient | null> {
    return this.repository.findOne({ where: { apiKeyHash } });
  }
}

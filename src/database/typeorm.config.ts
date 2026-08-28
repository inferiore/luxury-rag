import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Document } from '../modules/documents/entities/document.entity';
import { Chunk } from '../modules/chunks/entities/chunk.entity';
import { Job } from '../modules/jobs/entities/job.entity';

export const buildTypeOrmOptions = (
  configService: ConfigService,
): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: configService.get<string>('database.host'),
  port: configService.get<number>('database.port'),
  username: configService.get<string>('database.username'),
  password: configService.get<string>('database.password'),
  database: configService.get<string>('database.database'),
  entities: [Document, Chunk, Job],
  // El esquema vive únicamente en migraciones — nunca se auto-sincroniza.
  synchronize: false,
  migrationsRun: false,
});

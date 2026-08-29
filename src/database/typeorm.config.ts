import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Document } from '../modules/documents/entities/document.entity';
import { Chunk } from '../modules/chunks/entities/chunk.entity';
import { Job } from '../modules/jobs/entities/job.entity';
import { ApiClient } from '../modules/auth/entities/api-client.entity';

export const buildTypeOrmOptions = (
  configService: ConfigService,
): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: configService.get<string>('database.host'),
  port: configService.get<number>('database.port'),
  username: configService.get<string>('database.username'),
  password: configService.get<string>('database.password'),
  database: configService.get<string>('database.database'),
  // rejectUnauthorized: false es la opción pragmática estándar para
  // conectarse a Supabase con el driver pg (evita problemas de cadena de
  // CA intermedia); el tráfico sigue cifrado, solo sin validación completa
  // de la cadena. Decisión deliberada y aceptada — no se agrega manejo de
  // CA bundle.
  ssl: configService.get<boolean>('database.ssl')
    ? { rejectUnauthorized: false }
    : false,
  entities: [Document, Chunk, Job, ApiClient],
  // El esquema vive únicamente en migraciones — nunca se auto-sincroniza.
  synchronize: false,
  migrationsRun: false,
});

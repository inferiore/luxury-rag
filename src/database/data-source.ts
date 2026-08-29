import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { Document } from '../modules/documents/entities/document.entity';
import { Chunk } from '../modules/chunks/entities/chunk.entity';
import { Job } from '../modules/jobs/entities/job.entity';
import { ApiClient } from '../modules/auth/entities/api-client.entity';

dotenv.config();

/**
 * DataSource standalone usado solo por el CLI de TypeORM
 * (migration:run / migration:generate / migration:revert), fuera del
 * contexto de Nest — por eso carga el .env directamente con dotenv.
 */
const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST,
  port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  username: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  // rejectUnauthorized: false es la opción pragmática estándar para
  // conectarse a Supabase con el driver pg (evita problemas de cadena de
  // CA intermedia); el tráfico sigue cifrado, solo sin validación completa
  // de la cadena. Decisión deliberada y aceptada — no se agrega manejo de
  // CA bundle.
  ssl:
    process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
  entities: [Document, Chunk, Job, ApiClient],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  synchronize: false,
});

export default AppDataSource;

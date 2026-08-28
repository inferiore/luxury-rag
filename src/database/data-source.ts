import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { Document } from '../modules/documents/entities/document.entity';
import { Chunk } from '../modules/chunks/entities/chunk.entity';
import { Job } from '../modules/jobs/entities/job.entity';

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
  entities: [Document, Chunk, Job],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  synchronize: false,
});

export default AppDataSource;

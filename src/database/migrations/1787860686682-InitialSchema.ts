import { MigrationInterface, QueryRunner } from 'typeorm';

const VECTOR_DIM = parseInt(process.env.VECTOR_DIM ?? '1536', 10);

export class InitialSchema1787860686682 implements MigrationInterface {
  name = 'InitialSchema1787860686682';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // La extensión `vector` ya se habilita en spec 01 vía
    // rag/db/init/001-create-extension.sql, pero se repite aquí de forma
    // idempotente para que la migración también funcione contra una base
    // de datos fresca que no haya corrido ese init script.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

    await queryRunner.query(`
      CREATE TABLE documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        original_filename TEXT NOT NULL,
        total_items INT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE TABLE chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        nombre TEXT NOT NULL,
        descripcion TEXT,
        precio_publico NUMERIC,
        precio_dolar NUMERIC,
        lugar_embarque TEXT,
        lugar TEXT,
        ciudad TEXT,
        content TEXT NOT NULL,
        embedding VECTOR(${VECTOR_DIM}),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(
      `CREATE INDEX chunks_document_id_idx ON chunks (document_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX chunks_status_idx ON chunks (status);`,
    );
    await queryRunner.query(
      `CREATE INDEX chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops);`,
    );

    await queryRunner.query(`
      CREATE TABLE job_status (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        chunk_id UUID REFERENCES chunks(id) ON DELETE CASCADE,
        job_type VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        error_message TEXT,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS job_status;`);
    await queryRunner.query(`DROP TABLE IF EXISTS chunks;`);
    await queryRunner.query(`DROP TABLE IF EXISTS documents;`);
  }
}

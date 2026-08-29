import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tabla del registro de clientes de API (auth por api-key estática +
 * rate limiting por cliente). pgcrypto ya está habilitado por
 * InitialSchema1787860686682 — no hace falta CREATE EXTENSION aquí.
 * Los cuatro *_limit_per_window/*_window_seconds son nullable a propósito:
 * NULL significa "sin límite" para esa acción (ej. el cliente
 * backend-a-backend luxury-agent-tour-specialist), evitando un valor mágico
 * tipo -1 o 0 para "ilimitado".
 */
export class CreateApiClients1787953164682 implements MigrationInterface {
  name = 'CreateApiClients1787953164682';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE api_clients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL UNIQUE,
        api_key_hash TEXT NOT NULL UNIQUE,
        is_active BOOLEAN NOT NULL DEFAULT true,
        query_limit_per_window INT,
        query_window_seconds INT,
        upload_limit_per_window INT,
        upload_window_seconds INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS api_clients;`);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spec 02 v2 (`02-upload-y-chunking-job-v2.md`): reemplaza las 7 columnas
 * fijas de "tour" en `chunks` por una única columna `raw_data JSONB` —
 * `POST /documents/upload` deja de asumir un schema fijo de negocio y
 * acepta cualquier objeto JSON. Migración destructiva confirmada por Eder
 * (2026-08-27): los datos existentes son de prueba, no hay catálogo de
 * producción que preservar. Las filas ya existentes pierden sus columnas de
 * tour; `raw_data` queda en `{}` para ellas (no hay forma de reconstruir el
 * JSON original de v1, nunca se guardó crudo) — `content` no se toca y
 * sigue siendo válido.
 */
export class GenericChunkSchema1787867971123 implements MigrationInterface {
  name = 'GenericChunkSchema1787867971123';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chunks
        DROP COLUMN nombre,
        DROP COLUMN descripcion,
        DROP COLUMN precio_publico,
        DROP COLUMN precio_dolar,
        DROP COLUMN lugar_embarque,
        DROP COLUMN lugar,
        DROP COLUMN ciudad,
        ADD COLUMN raw_data JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);

    await queryRunner.query(
      `ALTER TABLE chunks ALTER COLUMN raw_data DROP DEFAULT;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chunks
        DROP COLUMN raw_data,
        ADD COLUMN nombre TEXT,
        ADD COLUMN descripcion TEXT,
        ADD COLUMN precio_publico NUMERIC,
        ADD COLUMN precio_dolar NUMERIC,
        ADD COLUMN lugar_embarque TEXT,
        ADD COLUMN lugar TEXT,
        ADD COLUMN ciudad TEXT;
    `);
  }
}

import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Document } from '../../documents/entities/document.entity';

export type ChunkStatus = 'pending' | 'processing' | 'done' | 'failed';

/**
 * NOTA: la columna `embedding` (tipo `vector(VECTOR_DIM)` de pgvector) se crea
 * en la migración vía SQL raw pero deliberadamente NO se mapea aquí como
 * @Column — TypeORM no tiene un tipo nativo para `vector`. Se lee/escribe con
 * SQL raw (`repository.query`) desde `ChunksRepository.markEmbeddingDone`
 * (spec 03), tal como indica 00-arquitectura-general.md.
 */
@Entity({ name: 'chunks' })
export class Chunk {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'document_id', type: 'uuid' })
  documentId: string;

  @ManyToOne(() => Document, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document: Document;

  @Column({ name: 'raw_data', type: 'jsonb' })
  rawData: Record<string, unknown>;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: ChunkStatus;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type DocumentStatus = 'pending' | 'processing' | 'done' | 'failed';

@Entity({ name: 'documents' })
export class Document {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'original_filename', type: 'text' })
  originalFilename: string;

  @Column({ name: 'total_items', type: 'int' })
  totalItems: number;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: DocumentStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

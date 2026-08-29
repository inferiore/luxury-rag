import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'api_clients' })
export class ApiClient {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text', unique: true })
  name: string;

  @Column({ name: 'api_key_hash', type: 'text', unique: true })
  apiKeyHash: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  // NULL = sin límite para esa acción (ej. luxury-agent-tour-specialist).
  @Column({ name: 'query_limit_per_window', type: 'int', nullable: true })
  queryLimitPerWindow: number | null;

  @Column({ name: 'query_window_seconds', type: 'int', nullable: true })
  queryWindowSeconds: number | null;

  @Column({ name: 'upload_limit_per_window', type: 'int', nullable: true })
  uploadLimitPerWindow: number | null;

  @Column({ name: 'upload_window_seconds', type: 'int', nullable: true })
  uploadWindowSeconds: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

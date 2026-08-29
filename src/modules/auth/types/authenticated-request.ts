import { Request } from 'express';
import { ApiClient } from '../entities/api-client.entity';

export interface AuthenticatedRequest extends Request {
  apiClient?: ApiClient;
}

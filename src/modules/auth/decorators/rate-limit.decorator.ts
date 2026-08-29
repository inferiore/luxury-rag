import { SetMetadata } from '@nestjs/common';

export type RateLimitAction = 'query' | 'upload';
export const RATE_LIMIT_ACTION_KEY = 'rateLimitAction';
export const RateLimit = (action: RateLimitAction) =>
  SetMetadata(RATE_LIMIT_ACTION_KEY, action);

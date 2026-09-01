import { Module } from '@nestjs/common';
import { BoldPaymentsService } from './bold-payments.service';

@Module({
  providers: [BoldPaymentsService],
  exports: [BoldPaymentsService],
})
export class BoldPaymentsModule {}

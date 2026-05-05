import { Module } from '@nestjs/common';
import { DisputeController } from '../controllers/dispute.controller';
import { DisputeProducer } from '../queue/dispute.producer';
import { DisputeWorker } from '../queue/dispute.worker';

@Module({
  controllers: [DisputeController],
  providers: [DisputeProducer, DisputeWorker],
})
export class DisputeModule {}

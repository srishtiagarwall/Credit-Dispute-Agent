import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import * as dotenv from 'dotenv';
import { DisputeModule } from './modules/dispute.module';

dotenv.config();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(DisputeModule, {
    logger: ['log', 'error', 'warn', 'debug'],
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  Logger.log(`Credit Dispute Agent running on port ${port}`, 'Bootstrap');
}

bootstrap().catch((err: Error) => {
  Logger.error(`Fatal startup error: ${err.message}`, err.stack, 'Bootstrap');
  process.exit(1);
});

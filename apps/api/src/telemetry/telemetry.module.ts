import { Module } from '@nestjs/common';
import { WebVitalsController } from './web-vitals.controller.js';

// What the web app reports about itself: Web Vitals (docs/observability.md#web-vitals).
@Module({
  controllers: [WebVitalsController],
})
export class TelemetryModule {}

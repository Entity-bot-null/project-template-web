import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RouteRateLimit, type RouteLimit } from '../common/guards/rate-limit.guard.js';
import { ApiErrors, ZodBody } from '../common/openapi/index.js';
import { recordWebVitals } from './web-vitals.js';
import { type WebVitalsReport, WebVitalsReportSchema } from './web-vitals.schemas.js';

// A page load reports once or twice (when the tab is hidden), so this only
// stops a client that floods the route; counted on top of the global limit.
export const WEB_VITALS_RATE_LIMIT: RouteLimit = { limit: 60, ttlSec: 60 };

// Public: the browser sends it with navigator.sendBeacon when the page is
// hidden, signed in or not. Cross-site requests are refused by the global
// Fetch Metadata guard and only JSON bodies are accepted (app.setup.ts), like
// on every route; nothing is stored but the metrics.
@ApiTags('telemetry')
@Controller('telemetry')
export class WebVitalsController {
  @Post('web-vitals')
  @HttpCode(204)
  @RouteRateLimit(WEB_VITALS_RATE_LIMIT)
  @ApiOperation({
    summary: 'Report the Web Vitals of a page load',
    description:
      'Sent by the web app when the page is hidden. Recorded as metrics by route pattern, metric, rating and navigation type (docs/observability.md#web-vitals); answered 204 also when metrics are off.',
  })
  @ZodBody(WebVitalsReportSchema)
  @ApiResponse({ status: 204, description: 'Recorded' })
  @ApiErrors(400, 403)
  report(@Body() body: WebVitalsReport): void {
    recordWebVitals(body);
  }
}

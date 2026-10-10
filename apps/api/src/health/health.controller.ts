import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiData, ApiErrors } from '../common/openapi/index.js';
import { LivenessSchema, ReadinessSchema } from './health.schemas.js';
import { HealthService } from './health.service.js';

// Probed by load balancers, orchestrators and uptime monitors, which must
// never compete with users for a rate limit. Public and side-effect free.
@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness: the process is up (restart it when this fails)' })
  @ApiData(LivenessSchema)
  live() {
    return this.health.live();
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness: dependencies are reachable (route traffic only while this passes)',
  })
  @ApiData(ReadinessSchema)
  @ApiErrors(503)
  ready() {
    return this.health.ready();
  }
}

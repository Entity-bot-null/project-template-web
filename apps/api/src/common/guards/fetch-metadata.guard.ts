import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { env } from '../../env/env.js';

// Resource isolation through Fetch Metadata, on every route (a global guard,
// registered before the rate limiter). Browsers label each request with
// Sec-Fetch-Site; anything a page from another origin made the browser send
// (a sibling subdomain included) is refused before any other work, unless that
// page's Origin is one of CORS_ORIGINS. That stops cross-site request forgery
// on the cookie routes, and stops other sites from using up a visitor's rate
// limit. Requests without the header pass: browsers that omit it still enforce
// the cookie's SameSite attribute, and non-browser clients (CLIs, servers,
// probes) carry no victim's cookies. docs/security.md#csrf-cors-xss
const SAFE_SITES = new Set(['same-origin', 'none']);

@Injectable()
export class FetchMetadataGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const site = req.get('Sec-Fetch-Site');
    if (site === undefined || SAFE_SITES.has(site)) return true;
    const origin = req.get('Origin');
    if (origin !== undefined && env.CORS_ORIGINS.includes(origin)) return true;
    throw new ForbiddenException('Cross-origin request refused');
  }
}

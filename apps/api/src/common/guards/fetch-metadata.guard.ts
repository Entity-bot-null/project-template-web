import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import type { Request } from 'express';
import { env } from '../../env/env.js';

// Resource isolation through Fetch Metadata, on every route (a global guard,
// registered before the rate limiter). Browsers label each request with
// Sec-Fetch-Site; anything a page from another origin made the browser send
// (a sibling subdomain included) is refused before any other work, unless that
// page's Origin is one of CORS_ORIGINS. That stops cross-site request forgery
// on the cookie routes, and stops other sites from using up a visitor's rate
// limit.
//
// Some browsers send no Fetch Metadata: older ones (Safari before 16.4), and
// every browser on a page served over plain HTTP from a non-local address.
// They still name the page in an Origin header on cross-origin requests and on
// same-origin POSTs, so a request without Sec-Fetch-Site but with an Origin
// must come from the app's own origin (APP_ORIGIN, or the address the request
// was sent to) or one of CORS_ORIGINS. Requests with neither header pass:
// non-browser clients (CLIs, servers, probes) carry no victim's cookies, and
// a browser that sends neither still applies the cookie's SameSite.
// docs/security.md#csrf-cors-xss
const SAFE_SITES = new Set(['same-origin', 'none']);

@Injectable()
export class FetchMetadataGuard implements CanActivate, OnModuleInit {
  // Behind a proxy that sends the API its own upstream name as Host (the web
  // image's nginx), the public origin is known from APP_ORIGIN only.
  onModuleInit(): void {
    if (env.NODE_ENV !== 'production' || env.APP_ORIGIN !== undefined) return;
    new Logger(FetchMetadataGuard.name).warn(
      'APP_ORIGIN is not set: behind a proxy, browsers that send no Fetch Metadata (Safari before 16.4) are refused on every request that carries an Origin, sign-in included (docs/security.md#csrf-cors-xss).',
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const site = req.get('Sec-Fetch-Site');
    if (site !== undefined && SAFE_SITES.has(site)) return true;
    const origin = req.get('Origin');
    if (origin !== undefined && env.CORS_ORIGINS.includes(origin)) return true;
    if (site === undefined && (origin === undefined || isOwnOrigin(origin, req))) return true;
    throw new ForbiddenException('Cross-origin request refused');
  }
}

/** The page is this app's: APP_ORIGIN, or the scheme and host the request was sent to. */
function isOwnOrigin(origin: string, req: Request): boolean {
  if (origin === env.APP_ORIGIN) return true;
  const host = req.get('Host');
  return host !== undefined && origin === `${req.protocol}://${host.toLowerCase()}`;
}

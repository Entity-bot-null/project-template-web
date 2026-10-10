import type { RequestUser } from './request-user.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by the request context middleware, echoed in X-Request-Id. */
      id?: string;
      /** Set by JwtAuthGuard, read through @CurrentUser(). */
      user?: RequestUser;
    }
  }
}

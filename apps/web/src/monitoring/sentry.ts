import {
  type Breadcrumb,
  type BrowserOptions,
  captureException,
  type ErrorEvent,
  init,
} from '@sentry/browser';
import type { InitConfig, Reporter } from './errorTracking';

// The Sentry SDK, in its own chunk: loaded only when the deployment set a DSN
// (errorTracking.ts). Errors only: no tracing, no session replay, no user
// feedback widget (each would add weight and collect more than needed).
// What leaves the browser is scrubbed first: no query strings (reset links,
// tokens), no cookies or headers, no user beyond an id.

/**
 * Every category of data the SDK could collect on its own, off (Sentry's
 * defaults collect cookies, headers, bodies, query strings and user details).
 */
export const DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
} satisfies BrowserOptions['dataCollection'];

export function initSentry(config: InitConfig): Reporter {
  init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    sampleRate: config.sampleRate,
    dataCollection: DATA_COLLECTION,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
  return (error, report) => {
    captureException(error, { tags: { source: report.source } });
  };
}

/** Breadcrumb fields that hold a URL (requests, navigations). */
const URL_FIELDS = new Set(['url', 'from', 'to']);

// Whole field names only: "status_code" is useful, "code" (an OAuth code) is not.
const SENSITIVE_FIELD =
  /^(?:token|access_?token|refresh_?token|id_?token|code|secret|password|api_?key|signature|session(?:_?id)?)$/i;

/** A URL without its query string and fragment. */
export function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request !== undefined) {
    const { url } = event.request;
    event.request = url === undefined ? {} : { url: withoutQuery(url) };
  }
  if (event.user !== undefined) {
    event.user = event.user.id === undefined ? {} : { id: event.user.id };
  }
  return event;
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  // Console output can hold anything the app printed: not sent.
  if (breadcrumb.category === 'console') return null;
  if (breadcrumb.data !== undefined) {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(breadcrumb.data)) {
      if (SENSITIVE_FIELD.test(key)) continue;
      data[key] = typeof value === 'string' && URL_FIELDS.has(key) ? withoutQuery(value) : value;
    }
    breadcrumb.data = data;
  }
  return breadcrumb;
}

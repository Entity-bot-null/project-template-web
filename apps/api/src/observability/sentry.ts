import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import {
  createStackParser,
  createTransport,
  type DataCollection,
  dedupeIntegration,
  type ErrorEvent,
  eventFiltersIntegration,
  functionToStringIntegration,
  linkedErrorsIntegration,
  Scope,
} from '@sentry/core';
import {
  nodeStackLineParser,
  ServerRuntimeClient,
  type ServerRuntimeClientOptions,
} from '@sentry/core/server';
import { reportableError } from '../common/logging/error-summary.js';
import type { ErrorContext, ErrorTracker } from './error-tracker.js';
import { redact, redactText, redactUrl } from './redact.js';

// The Sentry implementation of the error tracker, loaded only when SENTRY_DSN
// is set (error-tracker.ts). Built on @sentry/core, the base package of every
// Sentry SDK, rather than @sentry/node: that one installs its own
// OpenTelemetry setup (this API has its own, observability/telemetry-sdk.ts)
// and brings a CLI under a non-OSI license into production dependencies
// (docs/adr/0002-observability-and-optional-infrastructure.md).
//
// Nothing is collected implicitly: no breadcrumbs, no request data, no local
// variables. Each report carries the error, its stack and the ErrorContext the
// caller passed, and goes through scrubEvent before leaving.

const SEND_TIMEOUT_MS = 5_000;

/**
 * Every category of data the SDK could collect on its own, off: a report
 * carries what the code passes and nothing else. Sentry's defaults collect
 * cookies, headers, bodies, query strings and user details.
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
} satisfies DataCollection;

export interface SentryOptions {
  dsn: string;
  environment: string;
  release: string;
  sampleRate: number;
}

export function createSentryTracker(options: SentryOptions): ErrorTracker {
  // Typed, so an option that does not exist (renamed in a major) fails the build.
  const clientOptions: ServerRuntimeClientOptions = {
    dsn: options.dsn,
    environment: options.environment,
    release: options.release,
    sampleRate: options.sampleRate,
    dataCollection: DATA_COLLECTION,
    maxBreadcrumbs: 0,
    platform: 'node',
    runtime: { name: 'node', version: process.version },
    stackParser: createStackParser(nodeStackLineParser()),
    integrations: [
      eventFiltersIntegration(),
      functionToStringIntegration(),
      linkedErrorsIntegration(),
      dedupeIntegration(),
    ],
    transport: (transportOptions) =>
      createTransport(transportOptions, async (request) => {
        // Never traced: a report about a failure must not become spans of its own.
        const response = await context.with(suppressTracing(context.active()), () =>
          fetch(transportOptions.url, {
            method: 'POST',
            body: typeof request.body === 'string' ? request.body : new Uint8Array(request.body),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          }),
        );
        return {
          statusCode: response.status,
          headers: {
            'x-sentry-rate-limits': response.headers.get('x-sentry-rate-limits'),
            'retry-after': response.headers.get('retry-after'),
          },
        };
      }),
    beforeSend: (event) => scrubEvent(event),
  };
  const client = new ServerRuntimeClient(clientOptions);
  const base = new Scope();
  base.setClient(client);
  client.init();

  return {
    enabled: true,
    capture(error, errorContext = {}) {
      // A Prisma error's message can quote the query's arguments: reported by
      // class, code and frames, whoever captures it.
      client.captureException(reportableError(error), undefined, scopeFor(base, errorContext));
    },
    async flush(timeoutMs) {
      await client.flush(timeoutMs);
    },
    async close(timeoutMs) {
      await client.close(timeoutMs);
    },
  };
}

function scopeFor(base: Scope, errorContext: ErrorContext): Scope {
  const scope = base.clone();
  scope.setLevel(errorContext.level ?? 'error');
  const tags: Record<string, string | number> = {};
  if (errorContext.origin !== undefined) tags['error.origin'] = errorContext.origin;
  if (errorContext.dependency !== undefined) tags['dependency.name'] = errorContext.dependency;
  if (errorContext.requestId !== undefined) tags.request_id = errorContext.requestId;
  if (errorContext.method !== undefined) tags['http.method'] = errorContext.method;
  if (errorContext.route !== undefined) tags['http.route'] = errorContext.route;
  if (errorContext.statusCode !== undefined) tags['http.status_code'] = errorContext.statusCode;
  scope.setTags(tags);
  if (errorContext.userId !== undefined) scope.setUser({ id: errorContext.userId });
  // One issue per failing dependency and failure kind, not one per message.
  if (errorContext.origin === 'dependency' && errorContext.dependency !== undefined) {
    scope.setFingerprint(['{{ default }}', errorContext.dependency]);
  }
  return scope;
}

/**
 * The last check before an event leaves the process: request data reduced to
 * method and path, the user to an id, every message, value and field passed
 * through the same redaction as the logs. Exported for its spec.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request !== undefined) {
    const { method, url } = event.request;
    event.request = {};
    if (method !== undefined) event.request.method = method;
    if (url !== undefined) event.request.url = redactUrl(url);
  }
  if (event.user !== undefined) {
    event.user = event.user.id === undefined ? {} : { id: event.user.id };
  }
  if (event.message !== undefined) event.message = redactText(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value !== undefined) exception.value = redactText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
    }
  }
  delete event.breadcrumbs;
  if (event.extra !== undefined) event.extra = redact(event.extra);
  if (event.contexts !== undefined) event.contexts = redact(event.contexts);
  if (event.tags !== undefined) event.tags = redact(event.tags);
  return event;
}

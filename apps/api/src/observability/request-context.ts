import { AsyncLocalStorage } from 'node:async_hooks';
import { isSpanContextValid, trace } from '@opentelemetry/api';

// The request a piece of code runs for, without passing it around: the
// request-context middleware opens the context, and everything the request
// triggers (services, queries, outgoing calls, log lines) can read the id.
// That is what ties every log line, error report and outgoing call of one
// request together, and to the X-Request-Id the client received.

export interface RequestContext {
  readonly requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The id of the request being served, if any (none in boot code or timers). */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export interface CorrelationIds {
  requestId?: string;
  /** Set only while tracing is on (docs/observability.md#opentelemetry). */
  traceId?: string;
  spanId?: string;
}

/** The ids a log line or an error report carries to be found again. */
export function correlationIds(): CorrelationIds {
  const ids: CorrelationIds = {};
  const requestId = currentRequestId();
  if (requestId !== undefined) ids.requestId = requestId;
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (spanContext !== undefined && isSpanContextValid(spanContext)) {
    ids.traceId = spanContext.traceId;
    ids.spanId = spanContext.spanId;
  }
  return ids;
}

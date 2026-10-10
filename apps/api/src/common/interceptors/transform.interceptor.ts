import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';

/** Every successful response body. Errors use the same shape with data: null. */
export interface ApiEnvelope<T> {
  data: T | null;
  message: string;
}

export const DEFAULT_MESSAGE = 'Operation successful';

function isEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    'message' in value &&
    typeof value.message === 'string'
  );
}

// Controllers return plain values; this wraps them as { data, message }. A
// controller returns an envelope itself only to choose the message.
@Injectable()
export class TransformInterceptor implements NestInterceptor<unknown, ApiEnvelope<unknown>> {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<ApiEnvelope<unknown>> {
    return next
      .handle()
      .pipe(
        map((body: unknown) =>
          isEnvelope(body) ? body : { data: body ?? null, message: DEFAULT_MESSAGE },
        ),
      );
  }
}

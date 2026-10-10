import {
  type ArgumentMetadata,
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import type { z } from 'zod';

export type ValidationTarget = 'body' | 'query';

// Validates one argument type against a Zod schema and hands the parsed value
// (defaults applied, unknown keys stripped) to the handler. Used through
// @ZodBody and @ZodQuery, which also document the schema in OpenAPI.
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(
    private readonly schema: z.ZodType,
    private readonly target: ValidationTarget = 'body',
  ) {}

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== this.target) return value;
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(
        result.error.issues
          .map((issue) => `${issue.path.join('.') || this.target}: ${issue.message}`)
          .join(', '),
      );
    }
    return result.data;
  }
}

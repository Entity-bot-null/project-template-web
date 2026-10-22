import { BadRequestException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/** The one answer to a body the JSON parser could not read. */
export const MALFORMED_JSON_MESSAGE = 'The request body is not valid JSON';

// Follows the JSON parser (app.setup.ts). Left alone, Nest turns the parser's
// SyntaxError into a 400 carrying its text: positions and a fragment of what
// the client sent, a password included. The error filter answers this plain
// message instead; every other error goes on as it is.
export function malformedJson(
  error: unknown,
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next(isParseFailure(error) ? new BadRequestException(MALFORMED_JSON_MESSAGE) : error);
}

function isParseFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    error.type === 'entity.parse.failed'
  );
}

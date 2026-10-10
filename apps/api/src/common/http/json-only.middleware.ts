import type { NextFunction, Request, Response } from 'express';

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// What an HTML form can make a browser send without a CORS preflight.
const FORM_TYPES = new Set([
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
]);

// The API accepts JSON bodies only; anything else is refused before it is
// parsed. HTML forms (urlencoded, multipart, text/plain) are exactly what
// another site can make a browser send without a CORS preflight, so this
// closes that path to every route, on top of SameSite cookies and the Fetch
// Metadata check (docs/security.md#csrf-cors-xss). A form is refused even
// with an empty body: a bodiless form POST to a route that takes no body
// (logout) would otherwise reach its handler.
export function jsonOnly(req: Request, res: Response, next: NextFunction): void {
  if (!METHODS_WITH_BODY.has(req.method)) {
    next();
    return;
  }
  const form = FORM_TYPES.has(
    (req.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '',
  );
  if (!form && (!hasBody(req) || req.is('application/json') !== false)) {
    next();
    return;
  }
  res.status(415).json({ data: null, message: 'Request bodies must be application/json' });
}

function hasBody(req: Request): boolean {
  const length = req.get('Content-Length');
  return req.get('Transfer-Encoding') !== undefined || (length !== undefined && length !== '0');
}

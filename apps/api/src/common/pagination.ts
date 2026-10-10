import { z } from 'zod';

/** Upper bound for `limit` on every list route: no unbounded queries. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

// Offset pagination for list routes (docs/api-conventions.md#pagination).
// Query strings carry strings, hence z.coerce.
export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PageQuery = z.infer<typeof PageQuerySchema>;

/** A page of `item`: the requested slice plus the total across all pages. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().min(0),
  });
}

export interface Page<T> {
  items: T[];
  total: number;
}

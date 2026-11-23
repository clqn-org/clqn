import { ApiError, type PageQuery, pageQuerySchema } from '@clqn/shared';
import { z } from 'zod';

export function parsePage(query: Record<string, string>, cursor: z.ZodType<string> = z.uuid()): PageQuery {
  const parsed = pageQuerySchema.extend({ after: cursor.optional() }).safeParse(query);
  if (!parsed.success) throw new ApiError(400, 'INVALID_REQUEST', 'Use a limit between 1 and 200 and a valid cursor');
  return parsed.data;
}

export function pageResponse<T>(key: string, rows: T[], limit: number, cursor: (row: T) => string) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { [key]: items, ...(rows.length > limit && last ? { nextCursor: cursor(last) } : {}) };
}

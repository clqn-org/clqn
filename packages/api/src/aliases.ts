import { ApiError, resourceReferenceSchema } from '@clqn/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { agents } from './db/schema.js';
import type { tasks } from './db/tasks.js';

export function resourceFilter(table: typeof agents | typeof tasks, clanId: string, value: string | undefined) {
  const parsed = resourceReferenceSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(404, 'NOT_FOUND', table === agents ? 'Agent not found' : 'Task not found');
  const column = z.uuid().safeParse(parsed.data).success ? table.id : table.alias;
  return and(eq(table.clanId, clanId), eq(column, parsed.data));
}

export function rethrowAliasConflict(error: unknown): never {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
  if (
    cause?.code === '23505' &&
    (cause.constraint_name === 'agents_clan_alias_idx' || cause.constraint_name === 'tasks_clan_alias_idx')
  ) {
    throw new ApiError(409, 'ALIAS_CONFLICT', 'That alias is already in use for this resource type in the clan');
  }
  throw error;
}

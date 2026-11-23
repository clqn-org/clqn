import { type Actor, ApiError } from '@clqn/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import { events, memberships } from '../db/schema.js';

export type WorkspaceDb = PostgresJsDatabase;

export function requirePersonal(actor: Actor): void {
  if (actor.agentId) throw new ApiError(403, 'FORBIDDEN', 'A personal credential is required');
}

// Inside a transaction, lock the membership row so credential writes cannot race a member's removal.
export async function requireClan(db: WorkspaceDb, actor: Actor, clanId: string, lock?: 'share' | 'update') {
  if (!z.uuid().safeParse(clanId).success) throw new ApiError(404, 'NOT_FOUND', 'Clan not found');
  if (actor.agentId && actor.clanId !== clanId) throw new ApiError(404, 'NOT_FOUND', 'Clan not found');
  const query = db
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, actor.id), eq(memberships.clanId, clanId)));
  const [membership] = await (lock ? query.for(lock) : query);
  if (!membership) throw new ApiError(404, 'NOT_FOUND', 'Clan not found');
  return membership;
}

// Serializes a clan's writers until commit. Take it after row locks, as appendEvent does, to keep one lock order.
export async function lockClan(tx: Pick<WorkspaceDb, 'execute'>, clanId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${clanId}::text, 0))`);
}

// Allocate each clan's event cursor only after earlier writers commit, so polling cannot skip late commits.
export async function appendEvent(tx: Pick<WorkspaceDb, 'execute' | 'insert'>, event: typeof events.$inferInsert) {
  await lockClan(tx, event.clanId);
  const [row] = await tx.insert(events).values(event).returning({ sequence: events.sequence });
  if (!row) throw new Error('Event creation returned no row');
  return row.sequence;
}

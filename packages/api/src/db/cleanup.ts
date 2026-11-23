import { sql } from 'drizzle-orm';
import type { WorkspaceDb } from '../access.js';
import { limits } from '../limits.js';

// Operator-only maintenance. Keep current state; prune only old activity and historical records.
export async function cleanupDatabase(db: WorkspaceDb) {
  return db.transaction(async (tx) => {
    const [events] = await tx.execute<{ count: number }>(sql`
      with removed as (
        delete from events where created_at < now() - interval '90 days' returning 1
      ) select count(*)::integer as count from removed
    `);
    const [deliveries] = await tx.execute<{ count: number }>(sql`
      with removed as (
        delete from github_deliveries where received_at < now() - interval '30 days' returning 1
      ) select count(*)::integer as count from removed
    `);
    const [revisions] = await tx.execute<{ count: number }>(sql`
      with ranked as (
        select clan_id, key, revision,
          row_number() over (partition by clan_id, key order by revision desc) as position
        from context_revisions
      ), removed as (
        delete from context_revisions r using ranked old
        where old.position > ${limits.contextRevisionsKept}
          and r.clan_id = old.clan_id and r.key = old.key and r.revision = old.revision
        returning 1
      ) select count(*)::integer as count from removed
    `);
    return { events: events!.count, deliveries: deliveries!.count, revisions: revisions!.count };
  });
}

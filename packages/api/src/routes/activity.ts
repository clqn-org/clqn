import { type Actor, ApiError } from '@clqn/shared';
import { and, asc, count, desc, eq, gt } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { agents, clans, events, memberships } from '../db/schema.js';
import { tasks } from '../db/tasks.js';
import { requireClan, type WorkspaceDb } from '../lib/access.js';

const eventView = (row: typeof events.$inferSelect) => ({ ...row, createdAt: row.createdAt.toISOString() });
export function createActivityRoutes(db: WorkspaceDb) {
  const app = new Hono<{ Variables: { user: Actor } }>();
  const stats = async (clanId: string) => {
    const [[memberCount], [agentCount], taskCounts] = await Promise.all([
      db.select({ n: count() }).from(memberships).where(eq(memberships.clanId, clanId)),
      db.select({ n: count() }).from(agents).where(eq(agents.clanId, clanId)),
      db.select({ status: tasks.status, n: count() }).from(tasks).where(eq(tasks.clanId, clanId)).groupBy(tasks.status),
    ]);
    const counts = { open: 0, claimed: 0, completed: 0 };
    for (const row of taskCounts) counts[row.status] = row.n;
    return { members: memberCount!.n, agents: agentCount!.n, tasks: counts };
  };
  app.get('/events', async (c) => {
    const clanId = c.req.param('clanId')!;
    await requireClan(db, c.get('user'), clanId);
    const parsed = z
      .object({
        cursor: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        limit: z.coerce.number().int().min(1).max(100),
      })
      .safeParse({ cursor: c.req.query('cursor') ?? 0, limit: c.req.query('limit') ?? 100 });
    if (!parsed.success)
      throw new ApiError(400, 'INVALID_REQUEST', 'Use a nonnegative cursor and a limit between 1 and 100');
    const { cursor, limit } = parsed.data;
    const rows = await db
      .select()
      .from(events)
      .where(and(eq(events.clanId, clanId), gt(events.sequence, cursor)))
      .orderBy(asc(events.sequence))
      .limit(limit);
    return c.json({ events: rows.map(eventView), nextCursor: rows.at(-1)?.sequence ?? cursor });
  });
  app.get('/stats', async (c) => {
    const clanId = c.req.param('clanId')!;
    await requireClan(db, c.get('user'), clanId);
    return c.json(await stats(clanId));
  });
  app.get('/status', async (c) => {
    const clanId = c.req.param('clanId')!;
    await requireClan(db, c.get('user'), clanId);
    const [clan] = await db.select({ id: clans.id, name: clans.name }).from(clans).where(eq(clans.id, clanId));
    const recent = await db
      .select()
      .from(events)
      .where(eq(events.clanId, clanId))
      .orderBy(desc(events.sequence))
      .limit(10);
    return c.json({ clan: clan!, stats: await stats(clanId), recentActivity: recent.map(eventView) });
  });
  return app;
}

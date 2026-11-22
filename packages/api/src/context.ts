import { type Actor, ApiError, contextKeySchema, writeContextSchema } from '@clqn/shared';
import { and, count, eq, lte } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { appendEvent, lockClan, requireClan, type WorkspaceDb } from './access.js';
import { contextEntries, contextRevisions } from './db/context.js';
import { limitReached, limits } from './limits.js';

type EntryRow = typeof contextEntries.$inferSelect;
const view = ({ key, text, revision, updatedAt }: EntryRow) => ({
  key,
  text,
  revision,
  updatedAt: updatedAt.toISOString(),
});
const entryWhere = (clanId: string, key: string) => and(eq(contextEntries.clanId, clanId), eq(contextEntries.key, key));
const parseClan = (value: string | undefined) => {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new ApiError(404, 'NOT_FOUND', 'Clan not found');
  return parsed.data;
};
const parseKey = (value: string) => {
  const parsed = contextKeySchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'INVALID_REQUEST', 'Provide a context key between 1 and 200 characters');
  return parsed.data;
};

export function createContextRoutes(db: WorkspaceDb) {
  const app = new Hono<{ Variables: { user: Actor } }>();
  app.get('/', async (c) => {
    const clanId = parseClan(c.req.param('clanId'));
    await requireClan(db, c.get('user'), clanId);
    const rows = await db
      .select({ key: contextEntries.key, revision: contextEntries.revision, updatedAt: contextEntries.updatedAt })
      .from(contextEntries)
      .where(eq(contextEntries.clanId, clanId))
      .orderBy(contextEntries.key);
    return c.json({ entries: rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })) });
  });
  app.get('/:key/history', async (c) => {
    const clanId = parseClan(c.req.param('clanId'));
    await requireClan(db, c.get('user'), clanId);
    const key = parseKey(c.req.param('key'));
    const rows = await db
      .select()
      .from(contextRevisions)
      .where(and(eq(contextRevisions.clanId, clanId), eq(contextRevisions.key, key)))
      .orderBy(contextRevisions.revision);
    if (!rows.length) throw new ApiError(404, 'NOT_FOUND', 'Context entry not found');
    return c.json({ revisions: rows.map(view) });
  });
  app.get('/:key', async (c) => {
    const clanId = parseClan(c.req.param('clanId'));
    await requireClan(db, c.get('user'), clanId);
    const key = parseKey(c.req.param('key'));
    const [entry] = await db.select().from(contextEntries).where(entryWhere(clanId, key));
    if (!entry) throw new ApiError(404, 'NOT_FOUND', 'Context entry not found');
    return c.json(view(entry));
  });
  // JSON escapes may require six bytes for each text byte; text itself is limited to 64 KiB.
  app.post(
    '/:key',
    bodyLimit({
      maxSize: 400_000,
      onError: (c) => c.json({ error: { code: 'INVALID_REQUEST', message: 'Request body is too large' } }, 413),
    }),
    async (c) => {
      const clanId = parseClan(c.req.param('clanId'));
      const actor = c.get('user');
      await requireClan(db, actor, clanId);
      const key = parseKey(c.req.param('key'));
      const parsed = writeContextSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        throw new ApiError(
          400,
          'INVALID_REQUEST',
          'Provide text (at most 65536 UTF-8 bytes) and a nonnegative expectedRevision',
        );
      const { text, expectedRevision } = parsed.data;
      const entry = await db.transaction(async (tx) => {
        const updatedAt = new Date();
        const revision = expectedRevision + 1;
        const values = { clanId, key, text, revision, updatedAt };
        const [saved] =
          expectedRevision === 0
            ? await tx.insert(contextEntries).values(values).onConflictDoNothing().returning()
            : await tx
                .update(contextEntries)
                .set({ text, revision, updatedAt })
                .where(and(entryWhere(clanId, key), eq(contextEntries.revision, expectedRevision)))
                .returning();
        if (!saved) {
          if (
            expectedRevision > 0 &&
            !(await tx.select({ key: contextEntries.key }).from(contextEntries).where(entryWhere(clanId, key))).length
          ) {
            throw new ApiError(404, 'NOT_FOUND', 'Context entry not found; use expectedRevision 0 to create it');
          }
          throw new ApiError(
            409,
            'REVISION_CONFLICT',
            'Context revision changed; read the entry and retry with its current revision',
          );
        }
        if (expectedRevision === 0) {
          // Count after inserting, under the clan lock, so concurrent creations cannot exceed the cap.
          await lockClan(tx, clanId);
          const [entries] = await tx
            .select({ n: count() })
            .from(contextEntries)
            .where(eq(contextEntries.clanId, clanId));
          if (entries!.n > limits.contextEntriesPerClan)
            throw limitReached(`A clan can hold at most ${limits.contextEntriesPerClan} context entries`);
        }
        await tx.insert(contextRevisions).values(values);
        await tx
          .delete(contextRevisions)
          .where(
            and(
              eq(contextRevisions.clanId, clanId),
              eq(contextRevisions.key, key),
              lte(contextRevisions.revision, revision - limits.contextRevisionsKept),
            ),
          );
        await appendEvent(tx, {
          clanId,
          actorId: actor.id,
          agentId: actor.agentId,
          type: 'context.written',
          resourceId: key,
        });
        return view(saved);
      });
      return c.json(entry, expectedRevision === 0 ? 201 : 200);
    },
  );
  return app;
}

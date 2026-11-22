import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type Actor,
  ApiError,
  gitShaSchema,
  type LinkedRepository,
  linkRepositorySchema,
  repositorySlugSchema,
} from '@clqn/shared';
import { and, eq, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { appendEvent, requireClan, requirePersonal, type WorkspaceDb } from './access.js';
import { githubDeliveries, linkedRepositories } from './db/schema.js';

const metadata = (row: typeof linkedRepositories.$inferSelect): LinkedRepository => ({
  id: row.id,
  clanId: row.clanId,
  slug: row.slug,
  createdAt: row.createdAt.toISOString(),
  lastEventSequence: row.lastEventSequence,
});
const missing = () => new ApiError(404, 'NOT_FOUND', 'Linked repository not found');
const secretFor = (master: string, bindingId: string) => createHmac('sha256', master).update(bindingId).digest('hex');
const parseId = (id: string | undefined) => {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw missing();
  return parsed.data;
};
async function requireLeader(db: WorkspaceDb, actor: Actor, clanId: string) {
  requirePersonal(actor);
  if ((await requireClan(db, actor, clanId)).role !== 'leader') {
    throw new ApiError(403, 'FORBIDDEN', 'A personal clan leader credential is required');
  }
}

export function createRepositoryRoutes(db: WorkspaceDb, master?: string) {
  const app = new Hono<{ Variables: { user: Actor } }>();
  app.get('/', async (c) => {
    const clanId = c.req.param('clanId')!;
    await requireClan(db, c.get('user'), clanId);
    const rows = await db
      .select()
      .from(linkedRepositories)
      .where(eq(linkedRepositories.clanId, clanId))
      .orderBy(linkedRepositories.createdAt, linkedRepositories.id);
    return c.json({ repositories: rows.map(metadata) });
  });
  app.get('/:repositoryId', async (c) => {
    const clanId = c.req.param('clanId')!;
    await requireClan(db, c.get('user'), clanId);
    const id = parseId(c.req.param('repositoryId'));
    const [row] = await db
      .select()
      .from(linkedRepositories)
      .where(and(eq(linkedRepositories.clanId, clanId), eq(linkedRepositories.id, id)));
    if (!row) throw missing();
    return c.json(metadata(row));
  });
  app.post(
    '/',
    bodyLimit({
      maxSize: 4096,
      onError: (c) => c.json({ error: { code: 'INVALID_REQUEST', message: 'Request body is too large' } }, 413),
    }),
    async (c) => {
      const actor = c.get('user');
      const clanId = c.req.param('clanId')!;
      await requireLeader(db, actor, clanId);
      if (!master) throw new ApiError(503, 'WEBHOOK_UNAVAILABLE', 'GitHub webhooks are not configured on this server');
      const parsed = linkRepositorySchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new ApiError(400, 'INVALID_REQUEST', 'Provide a GitHub repository slug');
      const row = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(linkedRepositories)
          .values({ clanId, createdBy: actor.id, slug: parsed.data.slug })
          .onConflictDoNothing()
          .returning();
        if (inserted) {
          await appendEvent(tx, { clanId, actorId: actor.id, type: 'repository.linked', resourceId: inserted.slug });
          return inserted;
        }
        const [existing] = await tx
          .select()
          .from(linkedRepositories)
          .where(and(eq(linkedRepositories.clanId, clanId), eq(linkedRepositories.slug, parsed.data.slug)));
        if (!existing) throw new ApiError(409, 'REPOSITORY_CONFLICT', 'Repository link changed; try again');
        return existing;
      });
      return c.json({
        repository: metadata(row),
        webhook: { path: `/hooks/github/${row.id}`, secret: secretFor(master, row.id) },
      });
    },
  );
  app.post('/:repositoryId/unlink', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    await requireLeader(db, actor, clanId);
    const id = parseId(c.req.param('repositoryId'));
    const body = z
      .object({})
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, 'INVALID_REQUEST', 'Expected an empty JSON object');
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(linkedRepositories)
        .where(and(eq(linkedRepositories.clanId, clanId), eq(linkedRepositories.id, id)))
        .for('update');
      if (!row) throw missing();
      await tx.delete(linkedRepositories).where(eq(linkedRepositories.id, id));
      await appendEvent(tx, { clanId, actorId: actor.id, type: 'repository.unlinked', resourceId: row.slug });
    });
    return c.json({ unlinked: true as const });
  });
  return app;
}

const pushSchema = z.object({
  repository: z.object({ full_name: repositorySlugSchema, default_branch: z.string().min(1).max(255).default('main') }),
  ref: z.string().min(1).max(500),
  after: gitShaSchema,
  deleted: z.boolean().optional().default(false),
});

export function createGithubWebhookRoutes(db?: WorkspaceDb, master?: string) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.post(
    '/:bindingId',
    bodyLimit({
      maxSize: 2 * 1024 * 1024,
      onError: (c) => c.json({ error: { code: 'INVALID_REQUEST', message: 'Request body is too large' } }, 413),
    }),
    async (c) => {
      if (!db || !master)
        throw new ApiError(503, 'WEBHOOK_UNAVAILABLE', 'GitHub webhooks are not configured on this server');
      const id = parseId(c.req.param('bindingId'));
      const signature = c.req.header('x-hub-signature-256');
      const raw = Buffer.from(await c.req.arrayBuffer());
      const expected = createHmac('sha256', secretFor(master, id)).update(raw).digest();
      if (
        !signature ||
        !/^sha256=[0-9a-f]{64}$/.test(signature) ||
        !timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))
      ) {
        return c.json({ error: { code: 'INVALID_SIGNATURE', message: 'A valid GitHub signature is required' } }, 401);
      }
      const delivery = z.uuid().safeParse(c.req.header('x-github-delivery'));
      if (!delivery.success) throw new ApiError(400, 'INVALID_REQUEST', 'A valid GitHub delivery ID is required');
      const [binding] = await db.select().from(linkedRepositories).where(eq(linkedRepositories.id, id));
      if (!binding) throw missing();
      const event = c.req.header('x-github-event');
      if (event === 'ping') return c.json({ accepted: true });
      if (event !== 'push') return c.json({ accepted: true, ignored: true }, 202);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        parsed = null;
      }
      const payload = pushSchema.safeParse(parsed);
      if (!payload.success) throw new ApiError(400, 'INVALID_REQUEST', 'Provide a valid GitHub push payload');
      if (payload.data.repository.full_name !== binding.slug)
        throw new ApiError(400, 'REPOSITORY_MISMATCH', 'Push repository does not match the link');
      const result = await db.transaction(async (tx) => {
        // Lock the binding so unlink and delivery recording have a single committed order.
        const [current] = await tx.select().from(linkedRepositories).where(eq(linkedRepositories.id, id)).for('update');
        if (!current) throw missing();
        const [recorded] = await tx
          .insert(githubDeliveries)
          .values({ bindingId: id, deliveryId: delivery.data })
          .onConflictDoNothing()
          .returning();
        if (!recorded) return { accepted: true, duplicate: true };
        // GitHub redelivers for a few days at most; older IDs only take space.
        await tx
          .delete(githubDeliveries)
          .where(
            and(eq(githubDeliveries.bindingId, id), lt(githubDeliveries.receivedAt, sql`now() - interval '7 days'`)),
          );
        // Notify on the repository's default branch, whatever its name.
        const defaultRef = `refs/heads/${payload.data.repository.default_branch}`;
        if (payload.data.ref !== defaultRef) return { accepted: true, ignored: true };
        // actorId identifies the integration owner, not the GitHub pusher. No payload text or SHA is executed.
        const sequence = await appendEvent(tx, {
          clanId: current.clanId,
          actorId: current.createdBy,
          type: 'repository.main_changed',
          resourceId: current.slug,
        });
        await tx.update(linkedRepositories).set({ lastEventSequence: sequence }).where(eq(linkedRepositories.id, id));
        return { accepted: true, sequence };
      });
      return c.json(result);
    },
  );
  return app;
}

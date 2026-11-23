import { type Actor, ApiError, defaultPolicy, policySettingsSchema, updatePolicySchema } from '@clqn/shared';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { memberships } from '../db/schema.js';
import { appendEvent, requireClan, requirePersonal, type WorkspaceDb } from '../lib/access.js';

export function createPolicyRoutes(db: WorkspaceDb) {
  const app = new Hono<{ Variables: { user: Actor } }>();
  app.get('/', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    const membership = await requireClan(db, actor, clanId);
    return c.json({
      ...(membership.agentPolicy ?? defaultPolicy),
      clanId,
      userId: actor.id,
      revision: membership.policyRevision,
      enforcement: 'unavailable' as const,
    });
  });
  app.post(
    '/',
    bodyLimit({
      maxSize: 32768,
      onError: (c) => c.json({ error: { code: 'INVALID_REQUEST', message: 'Request body is too large' } }, 413),
    }),
    async (c) => {
      const actor = c.get('user');
      requirePersonal(actor);
      const clanId = c.req.param('clanId')!;
      await requireClan(db, actor, clanId);
      const parsed = updatePolicySchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        throw new ApiError(400, 'INVALID_REQUEST', 'Provide valid policy settings and expectedRevision');
      const { expectedRevision, ...changes } = parsed.data;
      const policy = await db.transaction(async (tx) => {
        // Serialize edits to the member's own policy. No leader or agent can edit another member's policy.
        const [membership] = await tx
          .select()
          .from(memberships)
          .where(and(eq(memberships.clanId, clanId), eq(memberships.userId, actor.id)))
          .for('update');
        if (!membership) throw new ApiError(404, 'NOT_FOUND', 'Clan not found');
        if (membership.policyRevision !== expectedRevision) {
          throw new ApiError(409, 'REVISION_CONFLICT', 'Policy changed; read the latest revision before updating');
        }
        const settings = policySettingsSchema.parse({ ...(membership.agentPolicy ?? defaultPolicy), ...changes });
        const revision = expectedRevision + 1;
        await tx
          .update(memberships)
          .set({ agentPolicy: settings, policyRevision: revision })
          .where(and(eq(memberships.clanId, clanId), eq(memberships.userId, actor.id)));
        await appendEvent(tx, { clanId, actorId: actor.id, type: 'policy.updated', resourceId: actor.id });
        return { ...settings, clanId, userId: actor.id, revision, enforcement: 'unavailable' as const };
      });
      return c.json(policy);
    },
  );
  return app;
}

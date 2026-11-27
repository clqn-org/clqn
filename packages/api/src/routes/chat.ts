import {
  type Actor,
  ApiError,
  chatApprovalSchema,
  chatBackupsInputSchema,
  chatDecisionRequestSchema,
  chatLeaseHeartbeatSchema,
  chatMetricsWindowSchema,
  chatRouteRequestSchema,
  chatSettingsSchema,
  chatUsageSchema,
  sendChatSchema,
} from '@clqn/shared';
import { sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { chatMembers, chats } from '../db/chat.js';
import { approveChat, decideChat, reportChat, requireChat, requireChatMember, sendChat } from '../db/chat-actions.js';
import { listChatBackups, requireChatLease, setChatBackups, updateChatLease } from '../db/chat-host.js';
import { chatMetrics } from '../db/chat-metrics.js';
import {
  chatActivity,
  chatHistory,
  chatIdentity,
  chatInfo,
  chatMergeQueue,
  chatUsage,
  forcePending,
  messageView,
} from '../db/chat-read.js';
import { chatWorkerFollowups, chatWorkInbox, chatWorkState, routeChatMessage } from '../db/chat-work.js';
import { requireClan, requirePersonal, type WorkspaceDb } from '../lib/access.js';

async function parse<T>(c: Context, schema: z.ZodType<T>) {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, 'INVALID_REQUEST', 'Invalid chat request');
  return parsed.data;
}
function uuid(value: string) {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new ApiError(404, 'NOT_FOUND', 'Invalid chat resource ID');
  return parsed.data;
}

function leaseQuery(c: Context) {
  const parsed = z.uuid().optional().safeParse(c.req.query('lease'));
  if (!parsed.success) throw new ApiError(400, 'INVALID_REQUEST', 'Provide a valid orchestrator lease ID');
  return parsed.data;
}

// Older clients omit allowedModels; keep the saved models instead of removing them.
async function parseSettings(c: Context) {
  const body = await c.req.json().catch(() => null);
  const parsed = chatSettingsSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, 'INVALID_REQUEST', 'Invalid chat request');
  return { settings: parsed.data, keepModels: !(body && typeof body === 'object' && 'allowedModels' in body) };
}

// Upserting one row is atomic, so concurrent edits by the same member cannot mix fields; the last one wins.
async function saveSettings(
  db: WorkspaceDb,
  clanId: string,
  userId: string,
  { settings, keepModels }: Awaited<ReturnType<typeof parseSettings>>,
) {
  const [saved] = await db
    .insert(chatMembers)
    .values({ clanId, userId, settings })
    .onConflictDoUpdate({
      target: [chatMembers.clanId, chatMembers.userId],
      set: {
        settings: keepModels
          ? sql`${JSON.stringify(settings)}::jsonb || jsonb_build_object('allowedModels', coalesce(${chatMembers.settings} -> 'allowedModels', 'null'::jsonb))`
          : settings,
      },
    })
    .returning({ settings: chatMembers.settings });
  return saved!.settings;
}

export function createChatRoutes(db: WorkspaceDb) {
  const app = new Hono<{ Variables: { user: Actor; tokenHash: string } }>();
  const requestLimit = (maxSize: number) =>
    bodyLimit({
      maxSize,
      onError: (c) => c.json({ error: { code: 'INVALID_REQUEST', message: 'Request body is too large' } }, 413),
    });
  const standardLimit = requestLimit(32 * 1024);
  // Routing several work items may include a complete description for each one.
  const routeLimit = requestLimit(208 * 1024);
  app.use('*', (c, next) => (c.req.path.endsWith('/route') ? routeLimit : standardLimit)(c, next));
  app.get('/', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    requirePersonal(actor);
    const membership = await requireClan(db, actor, clanId);
    return c.json(await chatInfo(db, clanId, actor.id, membership.role === 'leader'));
  });
  // Members save their own limits when joining the clan, before a session may exist. Only the member can edit them.
  app.post('/settings', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    requirePersonal(actor);
    const settings = await parseSettings(c);
    return c.json(
      await db.transaction(async (tx) => {
        await requireClan(tx, actor, clanId, 'share');
        return saveSettings(tx, clanId, actor.id, settings);
      }),
    );
  });
  app.post('/join', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    requirePersonal(actor);
    const settings = await parseSettings(c);
    return c.json(
      await db.transaction(async (tx) => {
        const membership = await requireClan(tx, actor, clanId, 'share');
        if (membership.role === 'leader')
          await tx.insert(chats).values({ clanId, hostId: actor.id }).onConflictDoNothing();
        await requireChat(tx, clanId, true);
        return saveSettings(tx, clanId, actor.id, settings);
      }),
    );
  });
  app.get('/state', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    requirePersonal(actor);
    const membership = await requireClan(db, actor, clanId);
    const member = await requireChatMember(db, clanId, actor.id);
    const [identity, history, activity, usage, mergeQueue, priority, work] = await Promise.all([
      chatIdentity(db, clanId, actor.id),
      chatHistory(db, clanId),
      chatActivity(db, clanId, actor.id),
      chatUsage(db, clanId, actor.id),
      membership.role === 'leader' ? chatMergeQueue(db, clanId) : undefined,
      forcePending(db, clanId),
      chatWorkState(db, clanId),
    ]);
    const safeNumber = (value: bigint) => Math.min(Number(value), Number.MAX_SAFE_INTEGER);
    return c.json({
      session: { clan: identity.clan, host: identity.host! },
      orchestration: {
        backup: identity.nominatedUserId === actor.id,
        eligible: membership.role === 'leader' || identity.nominatedUserId === actor.id,
        activeHost: identity.activeHost,
      },
      settings: member.settings,
      ...history,
      ...activity,
      forcePending: priority,
      work,
      ...(mergeQueue ? { mergeQueue } : {}),
      usage: { tokens: safeNumber(usage.tokens), reserved: safeNumber(usage.reserved), agents: usage.agents },
    });
  });
  app.get('/history', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    requirePersonal(actor);
    await requireClan(db, actor, clanId);
    await requireChatMember(db, clanId, actor.id);
    const before = z.coerce.number().int().positive().safeParse(c.req.query('before'));
    if (!before.success) throw new ApiError(400, 'INVALID_REQUEST', 'Provide a valid chat cursor');
    return c.json(await chatHistory(db, clanId, before.data));
  });
  app.get('/metrics', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    requirePersonal(actor);
    await requireClan(db, actor, clanId);
    await requireChatMember(db, clanId, actor.id);
    const window = chatMetricsWindowSchema.safeParse(c.req.query('window') ?? '24h');
    if (!window.success) throw new ApiError(400, 'INVALID_REQUEST', 'Choose a 24h or 7d window');
    return c.json(await chatMetrics(db, clanId, window.data));
  });
  app.post('/messages', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    requirePersonal(actor);
    const body = await parse(c, sendChatSchema);
    const message = await db.transaction(async (tx) => {
      await requireClan(tx, actor, clanId, 'share');
      await requireChat(tx, clanId, true);
      return sendChat(tx, actor, clanId, body);
    });
    return c.json(messageView(message), 201);
  });
  app.get('/host/backups', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    return c.json(await db.transaction((tx) => listChatBackups(tx, actor, clanId)));
  });
  app.post('/host/backups', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    const { userIds } = await parse(c, chatBackupsInputSchema);
    return c.json(await db.transaction((tx) => setChatBackups(tx, actor, clanId, userIds)));
  });
  for (const action of ['heartbeat', 'release'] as const) {
    app.post(`/host/${action}`, async (c) => {
      const actor = c.get('user');
      const clanId = c.req.param('clanId')!;
      const tokenHash = c.get('tokenHash');
      const { leaseId, renew } = await parse(c, chatLeaseHeartbeatSchema);
      return c.json(
        await db.transaction((tx) => updateChatLease(tx, actor, clanId, tokenHash, leaseId, action, renew === true)),
      );
    });
  }
  // The router and each sub-orchestrator take one message from their respective inbox.
  app.post('/inbox', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    const leaseId = leaseQuery(c);
    const workId = c.req.query('work');
    return c.json(
      await db.transaction(async (tx) => {
        await requireChatLease(tx, actor, clanId, c.get('tokenHash'), leaseId, workId !== undefined);
        return chatWorkInbox(tx, clanId, workId === undefined ? undefined : uuid(workId));
      }),
    );
  });
  app.post('/messages/:id/route', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    const id = uuid(c.req.param('id'));
    const leaseId = leaseQuery(c);
    const body = await parse(c, chatRouteRequestSchema);
    return c.json(
      await db.transaction(async (tx) => {
        await requireChatLease(tx, actor, clanId, c.get('tokenHash'), leaseId, true);
        return routeChatMessage(tx, actor, clanId, id, body);
      }),
    );
  });
  app.post('/messages/:id/decision', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    const id = uuid(c.req.param('id'));
    const leaseId = leaseQuery(c);
    const body = await parse(c, chatDecisionRequestSchema);
    return c.json(
      await db.transaction(async (tx) => {
        await requireChatLease(tx, actor, clanId, c.get('tokenHash'), leaseId);
        return decideChat(tx, actor, clanId, id, body, leaseId);
      }),
    );
  });
  app.post('/messages/:id/approval', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    requirePersonal(actor);
    const id = uuid(c.req.param('id'));
    const { approve } = await parse(c, chatApprovalSchema);
    return c.json(
      await db.transaction(async (tx) => {
        await requireClan(tx, actor, clanId, 'share');
        await requireChat(tx, clanId, true);
        return approveChat(tx, actor, clanId, id, approve);
      }),
    );
  });
  app.post('/tasks/:taskId/usage', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    const taskId = uuid(c.req.param('taskId'));
    const body = await parse(c, chatUsageSchema);
    return c.json(
      await db.transaction(async (tx) => {
        await requireClan(tx, actor, clanId, 'share');
        await requireChat(tx, clanId, true);
        return reportChat(tx, actor, clanId, taskId, body);
      }),
    );
  });
  app.get('/tasks/:taskId/followups', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    const taskId = uuid(c.req.param('taskId'));
    const after = z.coerce
      .number()
      .int()
      .nonnegative()
      .safeParse(c.req.query('after') ?? 0);
    if (!after.success) throw new ApiError(400, 'INVALID_REQUEST', 'Provide a valid follow-up cursor');
    return c.json(
      await db.transaction(async (tx) => {
        await requireClan(tx, actor, clanId, 'share');
        return chatWorkerFollowups(tx, actor, clanId, taskId, after.data);
      }),
    );
  });
  return app;
}

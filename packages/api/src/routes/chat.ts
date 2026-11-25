import {
  type Actor,
  ApiError,
  chatApprovalSchema,
  chatDecisionSchema,
  chatMetricsWindowSchema,
  chatSettingsSchema,
  chatUsageSchema,
  sendChatSchema,
} from '@clqn/shared';
import { sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { chatMembers, chats } from '../db/chat.js';
import {
  approveChat,
  decideChat,
  reportChat,
  requireChat,
  requireChatMember,
  requireOrchestrator,
  sendChat,
} from '../db/chat-actions.js';
import { chatMetrics } from '../db/chat-metrics.js';
import {
  chatActivity,
  chatHistory,
  chatIdentity,
  chatInfo,
  chatQueue,
  chatRuns,
  chatTokenHistory,
  chatUsage,
  messageView,
} from '../db/chat-read.js';
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
  const app = new Hono<{ Variables: { user: Actor } }>();
  app.use(
    '*',
    bodyLimit({
      maxSize: 32 * 1024,
      onError: (c) => c.json({ error: { code: 'INVALID_REQUEST', message: 'Request body is too large' } }, 413),
    }),
  );
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
    await requireClan(db, actor, clanId);
    const member = await requireChatMember(db, clanId, actor.id);
    const [identity, history, activity, usage, reportedTokensByHour] = await Promise.all([
      chatIdentity(db, clanId),
      chatHistory(db, clanId),
      chatActivity(db, clanId, actor.id),
      chatUsage(db, clanId, actor.id),
      chatTokenHistory(db, clanId),
    ]);
    const safeNumber = (value: bigint) => Math.min(Number(value), Number.MAX_SAFE_INTEGER);
    return c.json({
      session: { clan: identity.clan, host: identity.host! },
      settings: member.settings,
      ...history,
      ...activity,
      reportedTokensByHour,
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
  app.get('/inbox', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    await requireOrchestrator(db, actor, clanId);
    await requireChat(db, clanId);
    const [history, queued, held, runs] = await Promise.all([
      chatHistory(db, clanId),
      chatQueue(db, clanId, 'queued'),
      chatQueue(db, clanId, 'clarification'),
      chatRuns(db, clanId),
    ]);
    return c.json({ ...history, queued, held, runs });
  });
  app.post('/messages/:id/decision', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    const id = uuid(c.req.param('id'));
    const body = await parse(c, chatDecisionSchema);
    return c.json(
      await db.transaction(async (tx) => {
        await requireOrchestrator(tx, actor, clanId, 'share');
        await requireChat(tx, clanId, true);
        return decideChat(tx, actor, clanId, id, body);
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
  return app;
}

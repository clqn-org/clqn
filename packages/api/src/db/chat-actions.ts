import { randomUUID } from 'node:crypto';
import { type Actor, ApiError, type ChatDecision, type ChatUsage, type SendChat } from '@clqn/shared';
import { and, eq, sql } from 'drizzle-orm';
import { appendEvent, requireClan, type WorkspaceDb } from '../lib/access.js';
import { type ChatProposal, chatMembers, chatMessages, chats } from './chat.js';
import { chatUsage, memberScope, messageScope, workerBusy } from './chat-read.js';
import { agents, credentials } from './schema.js';
import { tasks } from './tasks.js';

const missing = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);
const conflict = (message: string) => new ApiError(409, 'CHAT_CONFLICT', message);
export const chatAcknowledged = { ok: true } as const;

export async function requireChat(db: WorkspaceDb, clanId: string, lock = false) {
  const query = db.select().from(chats).where(eq(chats.clanId, clanId));
  const [chat] = await (lock ? query.for('update') : query);
  if (!chat) throw missing('Session');
}

export async function requireChatMember(db: WorkspaceDb, clanId: string, userId: string) {
  const [member] = await db.select().from(chatMembers).where(memberScope(clanId, userId));
  if (!member) throw new ApiError(403, 'FORBIDDEN', 'Join the chat first');
  return member;
}

export async function requireOrchestrator(db: WorkspaceDb, actor: Actor, clanId: string, lock?: 'share') {
  const membership = await requireClan(db, actor, clanId, lock);
  if (membership.role === 'leader' && actor.agentId) {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, actor.agentId), eq(agents.clanId, clanId), eq(agents.role, 'orchestrator')));
    if (agent) return;
  }
  throw new ApiError(403, 'FORBIDDEN', 'The registered orchestrator is required');
}

async function getMessage(db: WorkspaceDb, clanId: string, id: string) {
  const [message] = await db
    .select()
    .from(chatMessages)
    .where(and(messageScope(clanId), eq(chatMessages.id, id)));
  if (!message) throw missing('Message');
  return message;
}

// Client-generated IDs make retries safe even if an HTTP response was lost after commit.
export async function addChatMessage(db: WorkspaceDb, message: typeof chatMessages.$inferInsert) {
  const [inserted] = await db.insert(chatMessages).values(message).onConflictDoNothing().returning();
  if (inserted) return inserted;
  const existing = await getMessage(db, message.clanId, message.id);
  if (
    existing.authorId !== message.authorId ||
    existing.role !== message.role ||
    existing.text !== message.text ||
    existing.replyTo !== (message.replyTo ?? null)
  )
    throw conflict('Message ID is already in use');
  return existing;
}

export async function sendChat(db: WorkspaceDb, actor: Actor, clanId: string, body: SendChat) {
  await requireChatMember(db, clanId, actor.id);
  if (body.replyTo) {
    const target = await getMessage(db, clanId, body.replyTo);
    if (target.role !== 'member') throw conflict('Choose a member message to reply to');
  }
  return addChatMessage(db, {
    ...body,
    authorId: actor.id,
    author: actor.email,
    role: 'member',
    clanId,
    status: 'queued',
  });
}

async function getWorker(db: WorkspaceDb, clanId: string, id: string) {
  const [worker] = await db
    .select({
      id: agents.id,
      ownerId: agents.ownerId,
      active: sql<boolean>`exists (select 1 from ${credentials} where credentials.agent_id = agents.id)`,
    })
    .from(agents)
    .where(and(eq(agents.clanId, clanId), eq(agents.id, id), eq(agents.role, 'worker')));
  if (!worker) throw missing('Worker');
  return worker;
}

async function admission(
  db: WorkspaceDb,
  clanId: string,
  worker: Awaited<ReturnType<typeof getWorker>>,
  estimate: number,
) {
  if (!worker.active) return 'The worker no longer has an active credential';
  const [owner] = await db.select().from(chatMembers).where(memberScope(clanId, worker.ownerId));
  if (!owner) return 'The worker owner must join the chat first';
  const { settings } = owner;
  const { tokens, reserved, agents: inUse } = await chatUsage(db, clanId, worker.ownerId);
  if (settings.tokenLimit !== null && tokens + reserved + BigInt(estimate) > BigInt(settings.tokenLimit))
    return 'This delegation would exceed your token limit';
  if (settings.agentLimit !== null && inUse >= settings.agentLimit)
    return 'This delegation would exceed your agent limit';
  if (await workerBusy(db, clanId, worker.id)) return 'This worker already has a chat task';
  return null;
}

async function setStatus(db: WorkspaceDb, id: string, status: typeof chatMessages.$inferSelect.status) {
  await db.update(chatMessages).set({ status }).where(eq(chatMessages.id, id));
}

async function assignChatTask(
  db: WorkspaceDb,
  actor: Actor,
  clanId: string,
  messageId: string,
  workerId: string,
  proposal: ChatProposal,
) {
  const [task] = await db
    .insert(tasks)
    .values({ clanId, description: proposal.description, assignedAgentId: workerId })
    .returning({ id: tasks.id });
  await db.update(chatMessages).set({ taskId: task!.id, status: 'handled' }).where(eq(chatMessages.id, messageId));
  for (const type of ['task.created', 'task.assigned']) {
    await appendEvent(db, { clanId, actorId: actor.id, agentId: actor.agentId ?? null, type, resourceId: task!.id });
  }
}

export async function decideChat(db: WorkspaceDb, actor: Actor, clanId: string, id: string, body: ChatDecision) {
  const message = await getMessage(db, clanId, id);
  if (message.status !== 'queued') throw conflict('This message has already been handled');
  const related = message.replyTo ? await getMessage(db, clanId, message.replyTo) : undefined;
  const held = related?.status === 'clarification' ? related : undefined;
  if (body.action === 'delegate') {
    if (related && !held) throw conflict('That clarification has already been resolved');
    const worker = await getWorker(db, clanId, body.workerId);
    if (!worker.active) throw conflict('Choose a worker with an active credential');
    const proposal = { title: body.title, description: body.description, estimatedTokens: body.estimatedTokens };
    await db
      .update(chatMessages)
      .set({ status: 'approval', workerId: worker.id, proposal })
      .where(eq(chatMessages.id, id));
    if (held) await setStatus(db, held.id, 'handled');
    const [owner] = await db.select().from(chatMembers).where(memberScope(clanId, worker.ownerId));
    const blocker =
      owner?.settings.approval === 'automatic'
        ? await admission(db, clanId, worker, proposal.estimatedTokens)
        : undefined;
    if (blocker === null) await assignChatTask(db, actor, clanId, id, worker.id, proposal);
    return { status: blocker === null ? 'handled' : 'approval', blocker: blocker ?? null };
  }

  let target = message.id;
  if (body.action === 'clarify') {
    target = body.hold ?? held?.id ?? message.id;
    const work = target === message.id ? message : await getMessage(db, clanId, target);
    if (work.taskId && work.status === 'handled') {
      const [task] = await db.select().from(tasks).where(eq(tasks.id, work.taskId)).for('update');
      if (task?.status !== 'open') throw conflict('Only unclaimed work can be held');
      if (task.assignedAgentId) {
        await db.update(tasks).set({ assignedAgentId: null, updatedAt: sql`now()` }).where(eq(tasks.id, task.id));
        await appendEvent(db, {
          clanId,
          actorId: actor.id,
          agentId: actor.agentId ?? null,
          type: 'task.unassigned',
          resourceId: task.id,
        });
      }
    } else if (!['queued', 'clarification', 'approval'].includes(work.status)) {
      throw conflict('Only queued or waiting work can be held');
    }
    await setStatus(db, work.id, 'clarification');
    if (work.id !== message.id) await setStatus(db, message.id, 'handled');
  } else {
    await setStatus(db, message.id, 'handled');
    if (held) await setStatus(db, held.id, 'handled');
  }
  await addChatMessage(db, {
    id: randomUUID(),
    clanId,
    authorId: actor.id,
    author: 'Orchestrator',
    role: 'orchestrator',
    text: body.text,
    status: 'handled',
    replyTo: target,
  });
  return { status: target === id && body.action === 'clarify' ? 'clarification' : 'handled', blocker: null };
}

export async function approveChat(db: WorkspaceDb, actor: Actor, clanId: string, id: string, approve: boolean) {
  await requireChatMember(db, clanId, actor.id);
  const message = await getMessage(db, clanId, id);
  if (!message.workerId || !message.proposal) throw missing('Approval');
  const worker = await getWorker(db, clanId, message.workerId);
  if (worker.ownerId !== actor.id)
    throw new ApiError(403, 'FORBIDDEN', 'Only the worker owner can answer this approval');
  if ((approve && message.status === 'handled' && message.taskId) || (!approve && message.status === 'declined'))
    return chatAcknowledged;
  if (message.status !== 'approval') throw conflict('This proposal is no longer awaiting approval');
  if (approve) {
    const reason = await admission(db, clanId, worker, message.proposal.estimatedTokens);
    if (reason) throw new ApiError(409, 'LIMIT_REACHED', reason);
    await assignChatTask(db, actor, clanId, id, worker.id, message.proposal);
  } else {
    await setStatus(db, id, 'declined');
  }
  return chatAcknowledged;
}

export async function reportChat(db: WorkspaceDb, actor: Actor, clanId: string, taskId: string, usage: ChatUsage) {
  if (!actor.agentId) throw new ApiError(403, 'FORBIDDEN', 'The assigned worker credential is required');
  const [row] = await db
    .select({ message: chatMessages, name: agents.name, owner: tasks.ownerAgentId })
    .from(chatMessages)
    .innerJoin(tasks, eq(tasks.id, chatMessages.taskId))
    .innerJoin(agents, eq(agents.id, chatMessages.workerId))
    .where(and(messageScope(clanId), eq(chatMessages.taskId, taskId)));
  if (!row) throw missing('Chat task');
  if (row.owner !== actor.agentId || row.message.workerId !== actor.agentId)
    throw new ApiError(403, 'FORBIDDEN', 'Only the task’s claimant can report usage');
  if (usage.tokens < (row.message.tokens ?? 0)) throw conflict('Cumulative usage cannot decrease');
  await db.update(chatMessages).set({ tokens: usage.tokens }).where(eq(chatMessages.id, row.message.id));
  if (usage.result) {
    await addChatMessage(db, {
      ...usage.result,
      authorId: actor.id,
      author: row.name,
      clanId,
      role: 'worker',
      status: 'handled',
      replyTo: row.message.id,
    });
  }
  return chatAcknowledged;
}

export async function isChatTask(db: WorkspaceDb, taskId: string) {
  const [row] = await db.select({ id: chatMessages.id }).from(chatMessages).where(eq(chatMessages.taskId, taskId));
  return Boolean(row);
}

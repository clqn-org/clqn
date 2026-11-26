import { randomUUID } from 'node:crypto';
import { type Actor, ApiError, type ChatDecisionRequest, type ChatUsage, type SendChat } from '@clqn/shared';
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { appendEvent, type WorkspaceDb } from '../lib/access.js';
import { type ChatProposal, chatMembers, chatMessages, chats, chatTokenHours } from './chat.js';
import {
  chatTokenRetention,
  chatUsage,
  currentChatHour,
  forcePending,
  memberScope,
  messageScope,
  workerBusy,
} from './chat-read.js';
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

// Settings saved before the session started also count as having joined it.
export async function requireChatMember(db: WorkspaceDb, clanId: string, userId: string) {
  const [member] = await db
    .select({ settings: chatMembers.settings })
    .from(chatMembers)
    .innerJoin(chats, eq(chats.clanId, chatMembers.clanId))
    .where(memberScope(clanId, userId));
  if (!member) throw new ApiError(403, 'FORBIDDEN', 'Join the chat first');
  return member;
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
    existing.force !== (message.force ?? false) ||
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
  const message = await addChatMessage(db, {
    ...body,
    authorId: actor.id,
    author: actor.email,
    role: 'member',
    clanId,
    status: 'queued',
  });
  if (message.force && message.status === 'queued') {
    // Invalidate the current ordinary turn's decision before the host sees the forced message.
    await db
      .update(chatMessages)
      .set({ pickedAt: null, pickId: null })
      .where(
        and(
          messageScope(clanId),
          eq(chatMessages.status, 'queued'),
          eq(chatMessages.force, false),
          isNotNull(chatMessages.pickedAt),
        ),
      );
  }
  return message;
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

// The share lock waits for, and then blocks, a concurrent edit of the owner's limits until commit.
async function ownerSettings(db: WorkspaceDb, clanId: string, ownerId: string) {
  const [owner] = await db.select().from(chatMembers).where(memberScope(clanId, ownerId)).for('share');
  return owner?.settings;
}

async function admission(
  db: WorkspaceDb,
  clanId: string,
  worker: Awaited<ReturnType<typeof getWorker>>,
  proposal: ChatProposal,
) {
  if (!worker.active) return 'The worker no longer has an active credential';
  const settings = await ownerSettings(db, clanId, worker.ownerId);
  if (!settings) return 'The worker owner must join the chat first';
  const models = settings.allowedModels ?? null;
  if (models && !models.includes(proposal.model ?? ''))
    return `This delegation's model is not in your allowed models (${models.join(', ')})`;
  const { tokens, reserved, agents: inUse } = await chatUsage(db, clanId, worker.ownerId);
  if (
    settings.tokenLimit !== null &&
    tokens + reserved + BigInt(proposal.estimatedTokens) > BigInt(settings.tokenLimit)
  )
    return 'This delegation would exceed your token limit';
  if (settings.agentLimit !== null && inUse >= settings.agentLimit)
    return 'This delegation would exceed your agent limit';
  if (await workerBusy(db, clanId, worker.id)) return 'This worker already has a chat task';
  return null;
}

async function setStatus(db: WorkspaceDb, id: string, status: typeof chatMessages.$inferSelect.status) {
  await db.update(chatMessages).set({ status }).where(eq(chatMessages.id, id));
}

// Records when a message first left the queue, for queue wait metrics.
async function markDecided(db: WorkspaceDb, id: string) {
  await db
    .update(chatMessages)
    .set({ decidedAt: sql`coalesce(${chatMessages.decidedAt}, clock_timestamp())` })
    .where(eq(chatMessages.id, id));
}

// An earlier chat task that can run again on its branch: stopped or released, or waiting on its pull request.
async function continuableTask(db: WorkspaceDb, clanId: string, taskId: string, workerId: string, lock = false) {
  const query = db
    .select({ task: tasks, message: chatMessages })
    .from(tasks)
    .innerJoin(chatMessages, eq(chatMessages.taskId, tasks.id))
    .where(and(eq(tasks.clanId, clanId), eq(tasks.id, taskId)));
  const [row] = await (lock ? query.for('update', { of: tasks }) : query);
  if (!row) throw missing('Chat task');
  const { task, message } = row;
  // The worktree, and any work not yet pushed, is on the machine of the worker that ran it.
  if (message.workerId !== workerId) throw conflict('Continue this task with the worker that ran it');
  if (task.status === 'completed' || task.repository?.state === 'merged')
    throw conflict('That task is finished; delegate new work instead');
  const released = task.status === 'open' && !task.assignedAgentId;
  const inReview =
    task.status === 'claimed' &&
    task.ownerAgentId === workerId &&
    (task.repository?.state === 'pushed' || task.repository?.state === 'open');
  if (!released && !inReview) throw conflict('That task is still queued or running; stop it before continuing');
  return row;
}

async function assignChatTask(
  db: WorkspaceDb,
  actor: Actor,
  clanId: string,
  messageId: string,
  workerId: string,
  proposal: ChatProposal,
) {
  let taskId: string;
  if (proposal.taskId) {
    // Move the task to this message, so each task keeps one current delegation and its usage carries over.
    const { task, message } = await continuableTask(db, clanId, proposal.taskId, workerId, true);
    taskId = task.id;
    const tokens = message.tokens ?? 0;
    await db.update(chatMessages).set({ taskId: null, tokens: null }).where(eq(chatMessages.id, message.id));
    await db
      .update(chatMessages)
      .set({
        taskId,
        status: 'handled',
        tokens: message.tokens,
        proposal: { ...proposal, estimatedTokens: proposal.estimatedTokens + tokens },
      })
      .where(eq(chatMessages.id, messageId));
    let repository = task.repository;
    if (repository) {
      // Pending until the worker reports its new head. A new head needs a new merge approval.
      const { mergeApproval: _approval, ...rest } = repository;
      repository = { ...rest, state: 'pending' };
    }
    await db
      .update(tasks)
      .set({
        // The worker gets the follow-up's self-contained description, in the worktree holding the earlier work.
        description: proposal.description,
        status: 'open',
        ownerId: null,
        ownerAgentId: null,
        assignedAgentId: workerId,
        repository,
        updatedAt: sql`now()`,
      })
      .where(eq(tasks.id, taskId));
  } else {
    const [task] = await db
      .insert(tasks)
      .values({ clanId, description: proposal.description, assignedAgentId: workerId })
      .returning({ id: tasks.id });
    taskId = task!.id;
    await db.update(chatMessages).set({ taskId, status: 'handled' }).where(eq(chatMessages.id, messageId));
    await appendEvent(db, {
      clanId,
      actorId: actor.id,
      agentId: actor.agentId ?? null,
      type: 'task.created',
      resourceId: taskId,
    });
  }
  await appendEvent(db, {
    clanId,
    actorId: actor.id,
    agentId: actor.agentId ?? null,
    type: 'task.assigned',
    resourceId: taskId,
  });
}

export async function decideChat(db: WorkspaceDb, actor: Actor, clanId: string, id: string, body: ChatDecisionRequest) {
  const message = await getMessage(db, clanId, id);
  if (message.status !== 'queued') throw conflict('This message has already been handled');
  if (body.pickId ? body.pickId !== message.pickId : !message.force && (await forcePending(db, clanId)))
    throw conflict('Take the next message from the inbox before deciding');
  await markDecided(db, id);
  const related = message.replyTo ? await getMessage(db, clanId, message.replyTo) : undefined;
  const held = related?.status === 'clarification' ? related : undefined;
  if (body.action === 'delegate') {
    if (related && !held) throw conflict('That clarification has already been resolved');
    const worker = await getWorker(db, clanId, body.workerId);
    if (!worker.active) throw conflict('Choose a worker with an active credential');
    const owner = await ownerSettings(db, clanId, worker.ownerId);
    const models = owner?.allowedModels ?? null;
    const model = body.model ?? models?.[0] ?? null;
    if (models && !models.includes(model!))
      throw new ApiError(
        409,
        'MODEL_NOT_ALLOWED',
        `The worker's owner allows only these models: ${models.join(', ')}. Choose one of them or another worker.`,
      );
    if (body.taskId) await continuableTask(db, clanId, body.taskId, worker.id);
    const proposal: ChatProposal = {
      title: body.title,
      description: body.description,
      estimatedTokens: body.estimatedTokens,
      model,
      ...(body.taskId ? { taskId: body.taskId } : {}),
    };
    await db
      .update(chatMessages)
      .set({ status: 'approval', workerId: worker.id, proposal })
      .where(eq(chatMessages.id, id));
    if (held) await setStatus(db, held.id, 'handled');
    const blocker = owner?.approval === 'automatic' ? await admission(db, clanId, worker, proposal) : undefined;
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
    if (work.status === 'queued') await markDecided(db, work.id);
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
    const reason = await admission(db, clanId, worker, message.proposal);
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
  const delta = usage.tokens - (row.message.tokens ?? 0);
  if (delta < 0) throw conflict('Cumulative usage cannot decrease');
  await db.update(chatMessages).set({ tokens: usage.tokens }).where(eq(chatMessages.id, row.message.id));
  if (delta > 0) {
    // The caller holds the session lock, so retries add only newly reported usage.
    await db
      .insert(chatTokenHours)
      .values({ clanId, hour: currentChatHour, tokens: delta })
      .onConflictDoUpdate({
        target: [chatTokenHours.clanId, chatTokenHours.hour],
        set: { tokens: sql`least(${chatTokenHours.tokens} + excluded.tokens, ${Number.MAX_SAFE_INTEGER})` },
      });
    await db
      .delete(chatTokenHours)
      .where(and(eq(chatTokenHours.clanId, clanId), lt(chatTokenHours.hour, chatTokenRetention)));
  }
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

import { randomUUID } from 'node:crypto';
import { type Actor, ApiError, type ChatRouteRequest } from '@clqn/shared';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { WorkspaceDb } from '../lib/access.js';
import { chatMessages } from './chat.js';
import { chatAcknowledged, decideChat, getMessage, markDecided, nextWorkOrder, setStatus } from './chat-actions.js';
import {
  chatHistory,
  chatQueue,
  messageScope,
  messageView,
  nextQueued,
  pickNext,
  runStatus,
  workScope,
} from './chat-read.js';
import { tasks } from './tasks.js';

const workNotFound = () => new ApiError(404, 'NOT_FOUND', 'Chat work not found');

export async function chatWorkState(db: WorkspaceDb, clanId: string) {
  const [[pending], ready] = await Promise.all([
    nextQueued(db, clanId),
    db
      .select({ workId: chatMessages.workId })
      .from(chatMessages)
      .where(and(messageScope(clanId), eq(chatMessages.status, 'queued'), isNotNull(chatMessages.workId)))
      .groupBy(chatMessages.workId)
      .orderBy(desc(sql`bool_or(${chatMessages.force})`), asc(sql`min(${chatMessages.sequence})`))
      .limit(120),
  ]);
  return { pending: pending?.id ?? null, ready: ready.map(({ workId }) => workId!) };
}

// Existing proposals keep their original task and approval. The first routed follow-up opts them in.
const isWork = or(
  isNotNull(chatMessages.workTitle),
  and(isNull(chatMessages.workId), isNotNull(chatMessages.proposal)),
);
const workRequest = alias(chatMessages, 'work_request');

function queryWork(db: WorkspaceDb, clanId: string, workId?: string) {
  return db
    .select({
      id: chatMessages.id,
      workId: chatMessages.workId,
      title: sql<string>`coalesce(${chatMessages.workTitle}, ${chatMessages.proposal}->>'title')`,
      requestId: workRequest.id,
      position: chatMessages.workPosition,
      status: chatMessages.status,
      workerId: chatMessages.workerId,
      taskStatus: tasks.status,
      assigned: tasks.assignedAgentId,
      inReview: isNotNull(tasks.repository),
    })
    .from(chatMessages)
    .leftJoin(tasks, eq(tasks.id, chatMessages.taskId))
    .leftJoin(
      workRequest,
      and(
        isNotNull(chatMessages.workPosition),
        eq(workRequest.clanId, chatMessages.clanId),
        eq(workRequest.id, chatMessages.replyTo),
      ),
    )
    .where(and(messageScope(clanId), isWork, workId ? eq(chatMessages.id, workId) : undefined));
}

type Work = Awaited<ReturnType<typeof queryWork>>[number];

function workView({ id, title, status, requestId, position, taskStatus, assigned, workerId, inReview }: Work) {
  const run = taskStatus && workerId && status === 'handled' ? runStatus({ taskStatus, assigned, workerId }) : status;
  return {
    id,
    title,
    status: run === 'running' && inReview ? 'review' : run,
    ...(requestId && position ? { requestId, position } : {}),
  };
}

async function chatWork(db: WorkspaceDb, clanId: string, workId: string) {
  const [work] = await queryWork(db, clanId, workId);
  if (!work) throw workNotFound();
  return work;
}

async function recentWork(db: WorkspaceDb, clanId: string) {
  const outstanding = or(
    inArray(chatMessages.status, ['approval', 'clarification', 'queued']),
    and(inArray(tasks.status, ['open', 'claimed']), eq(tasks.assignedAgentId, chatMessages.workerId)),
  );
  const rows = await queryWork(db, clanId)
    .orderBy(
      desc(sql`coalesce(${outstanding}, false)`),
      desc(sql`coalesce(${workRequest.sequence}, ${chatMessages.sequence})`),
      asc(chatMessages.workPosition),
    )
    .limit(60);
  return rows.map(workView);
}

export async function chatWorkInbox(db: WorkspaceDb, clanId: string, workId?: string) {
  const root = workId ? await chatWork(db, clanId, workId) : undefined;
  const picked = await pickNext(db, clanId, workId);
  const history = await chatHistory(db, clanId, undefined, 20, workId);
  if (root && !history.messages.some(({ id }) => id === root.id)) {
    history.messages.unshift(messageView(await getMessage(db, clanId, root.id)));
  }
  const held = await chatQueue(db, clanId, 'clarification', workId);
  const work = root
    ? { workItem: { ...workView(root), hasTask: root.workerId !== null } }
    : { work: await recentWork(db, clanId) };
  return { ...history, ...picked, held, ...work };
}

// The chat lease locks the chat for the whole decision. This also makes update cursors follow commit order.
export async function routeChatMessage(
  db: WorkspaceDb,
  actor: Actor,
  clanId: string,
  id: string,
  body: ChatRouteRequest,
) {
  const message = await getMessage(db, clanId, id);
  if (message.workId || message.role !== 'member' || message.status !== 'queued' || message.pickId !== body.pickId)
    throw new ApiError(409, 'CHAT_CONFLICT', 'Take the next message from the router inbox before routing');

  if (body.action === 'reply' || body.action === 'clarify') {
    await decideChat(db, actor, clanId, id, body);
    return chatAcknowledged;
  }

  if (body.action === 'start') {
    await db.insert(chatMessages).values(
      body.work.map(({ title, description }, index): typeof chatMessages.$inferInsert => {
        const workId = randomUUID();
        return {
          id: workId,
          clanId,
          authorId: actor.id,
          author: 'Orchestrator',
          role: 'orchestrator',
          text: description,
          status: 'queued',
          replyTo: id,
          workId,
          workTitle: title,
          workPosition: index + 1,
        };
      }),
    );
    await setStatus(db, id, 'handled');
  } else {
    const work = await chatWork(db, clanId, body.workId);
    if (!work.workId) {
      await db.update(chatMessages).set({ workId: work.id, workTitle: work.title }).where(eq(chatMessages.id, work.id));
    }
    await db
      .update(chatMessages)
      .set({ workId: work.id, workOrder: nextWorkOrder, pickedAt: null, pickId: null })
      .where(eq(chatMessages.id, id));
  }

  if (message.replyTo) {
    const target = await getMessage(db, clanId, message.replyTo);
    if (!target.workId && target.status === 'clarification') await setStatus(db, target.id, 'handled');
  }
  await markDecided(db, id);
  return chatAcknowledged;
}

export async function chatWorkerFollowups(
  db: WorkspaceDb,
  actor: Actor,
  clanId: string,
  taskId: string,
  after: number,
) {
  const forbidden = () =>
    new ApiError(403, 'FORBIDDEN', 'Only the assigned worker claiming this task can read follow-ups');
  if (!actor.agentId) throw forbidden();
  const [work] = await db
    .select({
      workId: chatMessages.workId,
      workerId: chatMessages.workerId,
      assigned: tasks.assignedAgentId,
      owner: tasks.ownerId,
      ownerAgent: tasks.ownerAgentId,
      status: tasks.status,
    })
    .from(tasks)
    .innerJoin(chatMessages, eq(tasks.id, chatMessages.taskId))
    .where(and(messageScope(clanId), eq(tasks.id, taskId)))
    .for('share', { of: tasks });
  if (!work) throw workNotFound();
  if (
    work.owner !== actor.id ||
    work.workerId !== actor.agentId ||
    work.assigned !== actor.agentId ||
    work.ownerAgent !== actor.agentId ||
    work.status !== 'claimed'
  )
    throw forbidden();
  if (!work.workId) return { messages: [], next: after };
  const rows = await db
    .select({ sequence: chatMessages.workOrder, id: chatMessages.id, text: chatMessages.text })
    .from(chatMessages)
    .where(and(messageScope(clanId), workScope(work.workId), gt(chatMessages.workOrder, after)))
    .orderBy(asc(chatMessages.workOrder))
    .limit(60);
  const messages = rows.map(({ sequence, ...message }) => ({ ...message, sequence: sequence! }));
  return { messages, next: messages.at(-1)?.sequence ?? after };
}

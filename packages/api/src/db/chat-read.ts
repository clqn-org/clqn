import {
  type ChatMergeRequest,
  type ChatMessage,
  type ChatRun,
  type ChatSettings,
  defaultChatSettings,
} from '@clqn/shared';
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { WorkspaceDb } from '../lib/access.js';
import { chatBackups, chatMembers, chatMessages, chats } from './chat.js';
import { liveChatLease } from './chat-host.js';
import { agents, clans, linkedRepositories, users } from './schema.js';
import { tasks } from './tasks.js';

export const messageScope = (clanId: string) => eq(chatMessages.clanId, clanId);
export const memberScope = (clanId: string, userId: string) =>
  and(eq(chatMembers.clanId, clanId), eq(chatMembers.userId, userId));

// A picked message stops showing as processing after this long, for example when the leader closes the chat mid-turn.
const processingFor = 5 * 60_000;

export function messageView(row: typeof chatMessages.$inferSelect): ChatMessage {
  const { id, sequence, authorId, author, role, createdAt, text, status, replyTo, pickedAt } = row;
  const processing = status === 'queued' && pickedAt !== null && Date.now() - pickedAt.getTime() < processingFor;
  return {
    id,
    sequence,
    authorId,
    author,
    role,
    createdAt: createdAt.toISOString(),
    text,
    status,
    replyTo,
    ...(processing ? { processing } : {}),
  };
}

export async function chatIdentity(db: WorkspaceDb, clanId: string, userId: string) {
  const activeUser = alias(users, 'active_host');
  const [identity] = await db
    .select({ host: users.email, clan: clans.name, nominatedUserId: chatBackups.userId, activeHost: activeUser.email })
    .from(clans)
    .leftJoin(chats, eq(chats.clanId, clans.id))
    .leftJoin(chatBackups, and(eq(chatBackups.clanId, chats.clanId), eq(chatBackups.userId, userId)))
    .leftJoin(users, eq(users.id, chats.hostId))
    .leftJoin(agents, and(eq(agents.id, chats.leaseAgentId), liveChatLease))
    .leftJoin(activeUser, eq(activeUser.id, agents.ownerId))
    .where(eq(clans.id, clanId));
  return identity!;
}

export async function chatInfo(
  db: WorkspaceDb,
  clanId: string,
  userId: string,
  canStart: boolean,
  defaults: ChatSettings = defaultChatSettings,
) {
  const [identity, [member]] = await Promise.all([
    chatIdentity(db, clanId, userId),
    db.select().from(chatMembers).where(memberScope(clanId, userId)),
  ]);
  const { clan, host } = identity;
  return { clan, session: host === null ? null : { clan, host }, canStart, settings: member?.settings ?? defaults };
}

export async function chatHistory(db: WorkspaceDb, clanId: string, before?: number, size = 60) {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(and(messageScope(clanId), before ? lt(chatMessages.sequence, before) : undefined))
    .orderBy(desc(chatMessages.sequence))
    .limit(size + 1);
  const page = rows.slice(0, size);
  return {
    before: rows.length > page.length ? page.at(-1)!.sequence : null,
    messages: page.reverse().map(messageView),
  };
}

export async function chatQueue(db: WorkspaceDb, clanId: string, status: 'queued' | 'clarification') {
  return (
    await db
      .select()
      .from(chatMessages)
      .where(and(messageScope(clanId), eq(chatMessages.status, status)))
      .orderBy(asc(chatMessages.sequence))
      .limit(60)
  ).map(messageView);
}

// Hands the orchestrator the oldest queued message, so it handles one at a time and members see which.
export async function pickNext(db: WorkspaceDb, clanId: string) {
  const [next] = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(and(messageScope(clanId), eq(chatMessages.status, 'queued')))
    .orderBy(asc(chatMessages.sequence))
    .limit(1);
  await db
    .update(chatMessages)
    .set({ pickedAt: null })
    .where(
      and(messageScope(clanId), isNotNull(chatMessages.pickedAt), next ? ne(chatMessages.id, next.id) : undefined),
    );
  if (!next) return null;
  const [picked] = await db
    .update(chatMessages)
    .set({ pickedAt: sql`clock_timestamp()` })
    .where(eq(chatMessages.id, next.id))
    .returning();
  return messageView(picked!);
}

export const activeRun = and(
  eq(tasks.assignedAgentId, chatMessages.workerId),
  inArray(tasks.status, ['open', 'claimed']),
  isNull(tasks.repository),
);

export async function chatUsage(db: WorkspaceDb, clanId: string, userId: string) {
  const [usage] = await db
    .select({
      tokens: sql<string>`coalesce(sum(${chatMessages.tokens}), 0)`,
      reserved: sql<string>`coalesce(sum(case when ${activeRun} then
        greatest((${chatMessages.proposal}->>'estimatedTokens')::bigint - coalesce(${chatMessages.tokens}, 0), 0)
        when (${tasks.status} = 'completed' or (${tasks.status} = 'claimed' and ${tasks.repository} is not null))
          and ${chatMessages.tokens} is null then
          (${chatMessages.proposal}->>'estimatedTokens')::bigint
        else 0 end), 0)`,
      agents: count(sql`case when ${activeRun} then 1 end`),
    })
    .from(chatMessages)
    .innerJoin(agents, eq(agents.id, chatMessages.workerId))
    .innerJoin(tasks, eq(tasks.id, chatMessages.taskId))
    .where(and(messageScope(clanId), eq(agents.ownerId, userId)));
  return { tokens: BigInt(usage!.tokens), reserved: BigInt(usage!.reserved), agents: usage!.agents };
}

export const currentChatHour = sql`date_trunc('hour', statement_timestamp(), 'UTC')`;
// Keep a week of hourly token reports for the metrics tab.
export const chatTokenRetention = sql`${currentChatHour} - ${7 * 24 - 1}::integer * interval '1 hour'`;

export async function workerBusy(db: WorkspaceDb, clanId: string, workerId: string) {
  const [busy] = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .innerJoin(tasks, eq(tasks.id, chatMessages.taskId))
    .where(and(messageScope(clanId), eq(chatMessages.workerId, workerId), activeRun))
    .limit(1);
  return Boolean(busy);
}

export const runStatus = (row: { taskStatus: string; assigned: string | null; workerId: string }): ChatRun['status'] =>
  row.taskStatus === 'completed'
    ? 'done'
    : row.assigned !== row.workerId
      ? 'released'
      : row.taskStatus === 'claimed'
        ? 'running'
        : 'queued';

export async function chatMergeQueue(db: WorkspaceDb, clanId: string): Promise<ChatMergeRequest[]> {
  const repository = tasks.repository;
  const rows = await db
    .select({ taskId: tasks.id, proposal: chatMessages.proposal, repository })
    .from(chatMessages)
    .innerJoin(tasks, eq(tasks.id, chatMessages.taskId))
    .innerJoin(
      linkedRepositories,
      and(eq(linkedRepositories.clanId, tasks.clanId), eq(linkedRepositories.slug, sql`${repository}->>'slug'`)),
    )
    .where(
      and(
        messageScope(clanId),
        eq(tasks.status, 'claimed'),
        sql`${repository}->>'state' = 'open'`,
        sql`(${repository}->'mergeApproval'->>'approved') is distinct from 'false'`,
      ),
    )
    .orderBy(
      sql`case when ${repository}->'mergeApproval'->>'approved' = 'true' then 0 else 1 end`,
      asc(chatMessages.sequence),
    )
    .limit(60);
  return rows.map(({ taskId, proposal, repository }) => ({ taskId, title: proposal!.title, repository: repository! }));
}

export async function chatActivity(db: WorkspaceDb, clanId: string, userId: string) {
  const [rows, approvals, [queue], [running], questions] = await Promise.all([
    db
      .select({
        id: chatMessages.id,
        proposal: chatMessages.proposal,
        worker: agents.name,
        tokens: chatMessages.tokens,
        assigned: tasks.assignedAgentId,
        workerId: agents.id,
        taskId: tasks.id,
        taskStatus: tasks.status,
        repository: tasks.repository,
      })
      .from(chatMessages)
      .innerJoin(agents, eq(agents.id, chatMessages.workerId))
      .innerJoin(tasks, eq(tasks.id, chatMessages.taskId))
      .where(and(messageScope(clanId), isNotNull(chatMessages.taskId)))
      .orderBy(
        sql`case when ${activeRun} then 0 when ${tasks.ownerId} = ${userId} and ${tasks.status} = 'claimed'
          and ${tasks.repository}->>'state' in ('pending', 'pushed') then 0 else 1 end`,
        desc(chatMessages.sequence),
      )
      .limit(40),
    db
      .select({ messageId: chatMessages.id, proposal: chatMessages.proposal, worker: agents.name })
      .from(chatMessages)
      .innerJoin(agents, eq(agents.id, chatMessages.workerId))
      .where(and(messageScope(clanId), eq(chatMessages.status, 'approval'), eq(agents.ownerId, userId)))
      .orderBy(asc(chatMessages.sequence))
      .limit(60),
    db
      .select({ total: count() })
      .from(chatMessages)
      .where(and(messageScope(clanId), eq(chatMessages.status, 'queued'))),
    db
      .select({ total: count() })
      .from(chatMessages)
      .innerJoin(tasks, eq(tasks.id, chatMessages.taskId))
      .where(and(messageScope(clanId), activeRun, eq(tasks.status, 'claimed'))),
    db
      .select({ question: chatMessages })
      .from(chatMessages)
      .innerJoin(
        sql`chat_messages held`,
        sql`held.id = ${chatMessages.replyTo} and held.clan_id = ${chatMessages.clanId} and held.status = 'clarification'`,
      )
      .where(
        and(messageScope(clanId), eq(chatMessages.role, 'orchestrator'), gt(chatMessages.sequence, sql`held.sequence`)),
      )
      .orderBy(desc(chatMessages.sequence))
      .limit(30),
  ]);
  const runs: ChatRun[] = rows.map((row) => ({
    messageId: row.id,
    title: row.proposal!.title,
    worker: row.worker,
    estimatedTokens: row.proposal!.estimatedTokens,
    model: row.proposal!.model ?? null,
    taskId: row.taskId,
    workerId: row.workerId,
    status: runStatus(row),
    tokens: row.tokens,
    ...(row.repository ? { repository: row.repository } : {}),
  }));
  return {
    queued: queue!.total,
    running: running!.total,
    questions: questions.map(({ question }) => messageView(question)),
    runs,
    approvals: approvals.map(({ proposal, ...row }) => ({
      ...row,
      title: proposal!.title,
      estimatedTokens: proposal!.estimatedTokens,
      model: proposal!.model ?? null,
    })),
  };
}

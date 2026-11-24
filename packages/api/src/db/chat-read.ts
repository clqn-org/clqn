import {
  type ChatMessage,
  type ChatRun,
  type ChatSettings,
  chatTokenHistoryHours,
  defaultChatSettings,
} from '@clqn/shared';
import { and, asc, count, desc, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { WorkspaceDb } from '../lib/access.js';
import { chatMembers, chatMessages, chats, chatTokenHours } from './chat.js';
import { agents, clans, users } from './schema.js';
import { tasks } from './tasks.js';

export const messageScope = (clanId: string) => eq(chatMessages.clanId, clanId);
export const memberScope = (clanId: string, userId: string) =>
  and(eq(chatMembers.clanId, clanId), eq(chatMembers.userId, userId));

export function messageView(row: typeof chatMessages.$inferSelect): ChatMessage {
  const { id, sequence, authorId, author, role, createdAt, text, status, replyTo } = row;
  return { id, sequence, authorId, author, role, createdAt: createdAt.toISOString(), text, status, replyTo };
}

export async function chatIdentity(db: WorkspaceDb, clanId: string) {
  const [identity] = await db
    .select({ host: users.email, clan: clans.name })
    .from(clans)
    .leftJoin(chats, eq(chats.clanId, clans.id))
    .leftJoin(users, eq(users.id, chats.hostId))
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
    chatIdentity(db, clanId),
    db.select().from(chatMembers).where(memberScope(clanId, userId)),
  ]);
  const { clan, host } = identity;
  return { clan, session: host === null ? null : { clan, host }, canStart, settings: member?.settings ?? defaults };
}

export async function chatHistory(db: WorkspaceDb, clanId: string, before?: number) {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(and(messageScope(clanId), before ? lt(chatMessages.sequence, before) : undefined))
    .orderBy(desc(chatMessages.sequence))
    .limit(61);
  const page = rows.slice(0, 60);
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

const activeRun = and(eq(tasks.assignedAgentId, chatMessages.workerId), inArray(tasks.status, ['open', 'claimed']));

export async function chatUsage(db: WorkspaceDb, clanId: string, userId: string) {
  const [usage] = await db
    .select({
      tokens: sql<string>`coalesce(sum(${chatMessages.tokens}), 0)`,
      reserved: sql<string>`coalesce(sum(case when ${activeRun} then
        greatest((${chatMessages.proposal}->>'estimatedTokens')::bigint - coalesce(${chatMessages.tokens}, 0), 0)
        when ${tasks.status} = 'completed' and ${chatMessages.tokens} is null then
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
export const firstChatHour = sql`${currentChatHour} - ${chatTokenHistoryHours - 1}::integer * interval '1 hour'`;

export async function chatTokenHistory(db: WorkspaceDb, clanId: string) {
  const rows = await db.execute<{ tokens: string }>(sql`
    select coalesce(bucket.tokens, 0)::text as tokens
    from generate_series(${firstChatHour}, ${currentChatHour}, interval '1 hour') as hours(hour)
    left join ${chatTokenHours} as bucket on bucket.clan_id = ${clanId} and bucket.hour = hours.hour
    order by hours.hour
  `);
  return rows.map(({ tokens }) => Number(tokens));
}

export async function workerBusy(db: WorkspaceDb, clanId: string, workerId: string) {
  const [busy] = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .innerJoin(tasks, eq(tasks.id, chatMessages.taskId))
    .where(and(messageScope(clanId), eq(chatMessages.workerId, workerId), activeRun))
    .limit(1);
  return Boolean(busy);
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
      })
      .from(chatMessages)
      .innerJoin(agents, eq(agents.id, chatMessages.workerId))
      .innerJoin(tasks, eq(tasks.id, chatMessages.taskId))
      .where(and(messageScope(clanId), isNotNull(chatMessages.taskId)))
      .orderBy(sql`case when ${activeRun} then 0 else 1 end`, desc(chatMessages.sequence))
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
    taskId: row.taskId,
    status:
      row.taskStatus === 'completed'
        ? 'done'
        : row.assigned !== row.workerId
          ? 'released'
          : row.taskStatus === 'claimed'
            ? 'running'
            : 'queued',
    tokens: row.tokens,
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
    })),
  };
}

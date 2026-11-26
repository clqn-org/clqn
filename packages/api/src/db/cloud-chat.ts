import { randomUUID } from 'node:crypto';
import { ApiError, type ChatDecision, type ChatMessage } from '@clqn/shared';
import { and, asc, desc, eq, inArray, notExists, sql } from 'drizzle-orm';
import type { WorkspaceDb } from '../lib/access.js';
import { chatMembers, chatMessages, chats, cloudChatQuota, cloudWorkerPresence } from './chat.js';
import { decideChat } from './chat-actions.js';
import { activeRun, chatHistory, chatUsage, messageView } from './chat-read.js';
import { agents, memberships, users } from './schema.js';
import { tasks } from './tasks.js';

export interface CloudChatClaim {
  clanId: string;
  messageId: string;
  leaseId: string;
  attempt: number;
}

export interface CloudChatWorker {
  id: string;
  ownerId: string;
  name: string;
  allowedModels: string[] | null;
  availableTokens: number | null;
}

export interface CloudChatContext {
  next: ChatMessage;
  messages: ChatMessage[];
  related: ChatMessage | null;
  question: string | null;
  workers: CloudChatWorker[];
}

const hasCredential = sql`exists (select 1 from credentials c where c.agent_id = agents.id)`;
const clearLease = { cloudLeaseId: null, cloudMessageId: null, cloudLeaseExpiresAt: null };
const heldLease = ({ clanId, messageId, leaseId }: CloudChatClaim) =>
  and(
    eq(chats.clanId, clanId),
    eq(chats.cloudMessageId, messageId),
    eq(chats.cloudLeaseId, leaseId),
    sql`${chats.cloudLeaseExpiresAt} > clock_timestamp()`,
  );

export async function cloudLeader(db: WorkspaceDb, clanId: string, lock = false) {
  const query = db
    .select({ id: users.id, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(memberships.clanId, clanId), eq(memberships.role, 'leader')))
    .limit(1);
  const [leader] = await (lock ? query.for('share', { of: memberships }) : query);
  return leader;
}

export async function recordWorkerPresence(db: WorkspaceDb, clanId: string, ownerId: string, agentIds: string[]) {
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return;
  const owned = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.clanId, clanId),
        eq(agents.ownerId, ownerId),
        eq(agents.role, 'worker'),
        inArray(agents.id, ids),
        hasCredential,
      ),
    );
  if (owned.length !== ids.length)
    throw new ApiError(403, 'FORBIDDEN', 'Presence can only be reported for your active workers in this clan');
  await db
    .insert(cloudWorkerPresence)
    .values(owned.map(({ id }) => ({ agentId: id, seenAt: sql`clock_timestamp()` })))
    .onConflictDoUpdate({ target: cloudWorkerPresence.agentId, set: { seenAt: sql`clock_timestamp()` } });
}

export async function claimCloudChat(db: WorkspaceDb, maxCallsPerHour = 120): Promise<CloudChatClaim | null> {
  return db.transaction(async (tx) => {
    // Keep one in-flight turn per clan. SKIP LOCKED lets another replica claim another clan immediately.
    const [candidate] = await tx.execute<{ clanId: string; messageId: string }>(sql`
      select ${chats.clanId} as "clanId", pending.id as "messageId"
      from ${chats}
      cross join lateral (
        select ${chatMessages.id}, ${chatMessages.sequence}
        from ${chatMessages}
        where ${chatMessages.clanId} = ${chats.clanId} and ${chatMessages.status} = 'queued'
        order by ${chatMessages.sequence}
        limit 1
      ) pending
      where (${chats.cloudLeaseExpiresAt} is null or ${chats.cloudLeaseExpiresAt} <= clock_timestamp())
        and (${chats.cloudRetryAt} is null or ${chats.cloudRetryAt} <= clock_timestamp())
      order by ${chats.cloudLastAttemptAt} nulls first, pending.sequence
      limit 1 for update of chats skip locked
    `);
    if (!candidate) return null;
    // One durable UTC-hour counter caps requests across all runner replicas, including retries.
    const [reserved] = await tx.execute<{ calls: number }>(sql`
      insert into ${cloudChatQuota} as quota (id, hour, calls)
      values (1, date_trunc('hour', clock_timestamp(), 'UTC'), 1)
      on conflict (id) do update set
        calls = case when quota.hour < excluded.hour then 1 else quota.calls + 1 end,
        hour = greatest(quota.hour, excluded.hour)
      where quota.hour < excluded.hour or quota.calls < ${maxCallsPerHour}
      returning calls
    `);
    if (!reserved) return null;
    const leaseId = randomUUID();
    const [chat] = await tx
      .update(chats)
      .set({
        cloudLeaseId: leaseId,
        cloudMessageId: candidate.messageId,
        cloudLeaseExpiresAt: sql`clock_timestamp() + interval '90 seconds'`,
        cloudLastAttemptAt: sql`clock_timestamp()`,
        cloudAttempts: sql`case when ${chats.cloudMessageId} = ${candidate.messageId}
          then least(${chats.cloudAttempts} + 1, 100) else 1 end`,
      })
      .where(eq(chats.clanId, candidate.clanId))
      .returning({ attempt: chats.cloudAttempts });
    await tx
      .update(chatMessages)
      .set({ pickedAt: sql`clock_timestamp()` })
      .where(eq(chatMessages.id, candidate.messageId));
    return { ...candidate, leaseId, attempt: chat!.attempt };
  });
}

async function availableWorkers(
  db: WorkspaceDb,
  clanId: string,
  options: { workerId?: string; preferredOwner?: string } = {},
): Promise<CloudChatWorker[]> {
  const busy = db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .innerJoin(tasks, eq(tasks.id, chatMessages.taskId))
    .where(and(eq(chatMessages.clanId, clanId), eq(chatMessages.workerId, agents.id), activeRun));
  const query = db
    .select({ id: agents.id, ownerId: agents.ownerId, name: agents.name, settings: chatMembers.settings })
    .from(agents)
    .innerJoin(cloudWorkerPresence, eq(cloudWorkerPresence.agentId, agents.id))
    .innerJoin(chatMembers, and(eq(chatMembers.clanId, agents.clanId), eq(chatMembers.userId, agents.ownerId)))
    .where(
      and(
        eq(agents.clanId, clanId),
        eq(agents.role, 'worker'),
        options.workerId ? eq(agents.id, options.workerId) : undefined,
        sql`${cloudWorkerPresence.seenAt} > clock_timestamp() - interval '45 seconds'`,
        hasCredential,
        notExists(busy),
      ),
    )
    .orderBy(
      sql`${agents.ownerId} is distinct from ${options.preferredOwner ?? null}`,
      asc(agents.createdAt),
      asc(agents.id),
    )
    .limit(20);
  const rows = await (options.workerId ? query.for('share', { of: [chatMembers, cloudWorkerPresence] }) : query);
  const owners = [...new Set(rows.map(({ ownerId }) => ownerId))];
  const usage = new Map(await Promise.all(owners.map(async (id) => [id, await chatUsage(db, clanId, id)] as const)));
  return rows.flatMap(({ settings, ownerId, ...worker }) => {
    const { agents: inUse, tokens, reserved } = usage.get(ownerId)!;
    if (settings.agentLimit !== null && inUse >= settings.agentLimit) return [];
    const availableTokens =
      settings.tokenLimit === null ? null : Number(BigInt(settings.tokenLimit) - tokens - reserved);
    if (availableTokens !== null && availableTokens <= 0) return [];
    return [{ ...worker, ownerId, allowedModels: settings.allowedModels ?? null, availableTokens }];
  });
}

export async function cloudChatContext(db: WorkspaceDb, claim: CloudChatClaim): Promise<CloudChatContext | null> {
  const [row] = await db
    .select({ message: chatMessages })
    .from(chats)
    .innerJoin(chatMessages, and(eq(chatMessages.clanId, chats.clanId), eq(chatMessages.id, chats.cloudMessageId)))
    .where(and(heldLease(claim), eq(chatMessages.status, 'queued')));
  if (!row) return null;
  const { replyTo } = row.message;
  const [history, workers, [related], [question]] = await Promise.all([
    chatHistory(db, claim.clanId, undefined, 16),
    availableWorkers(db, claim.clanId, { preferredOwner: row.message.authorId }),
    replyTo
      ? db
          .select()
          .from(chatMessages)
          .where(and(eq(chatMessages.clanId, claim.clanId), eq(chatMessages.id, replyTo)))
      : [],
    replyTo
      ? db
          .select({ text: chatMessages.text })
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.clanId, claim.clanId),
              eq(chatMessages.replyTo, replyTo),
              eq(chatMessages.role, 'orchestrator'),
            ),
          )
          .orderBy(desc(chatMessages.sequence))
          .limit(1)
      : [],
  ]);
  return {
    next: messageView(row.message),
    messages: history.messages,
    related: related ? messageView(related) : null,
    question: question?.text ?? null,
    workers,
  };
}

export async function finishCloudChat(
  db: WorkspaceDb,
  claim: CloudChatClaim,
  decision: ChatDecision,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { clanId, messageId } = claim;
    // Leadership and worker membership changes serialize with decisions. Match the membership-before-chat lock order.
    const leader = await cloudLeader(tx, clanId, true);
    if (!leader) return false;
    if (decision.action === 'delegate') {
      const [owner] = await tx
        .select({ id: memberships.userId })
        .from(agents)
        .innerJoin(memberships, and(eq(agents.clanId, memberships.clanId), eq(agents.ownerId, memberships.userId)))
        .where(and(eq(agents.clanId, clanId), eq(agents.id, decision.workerId), eq(agents.role, 'worker')))
        .for('share', { of: memberships });
      if (!owner) throw workerUnavailable();
    }
    const [chat] = await tx.select({ clanId: chats.clanId }).from(chats).where(heldLease(claim)).for('update');
    if (!chat) return false;
    if (decision.action === 'delegate') {
      const [worker] = await availableWorkers(tx, clanId, { workerId: decision.workerId });
      if (!worker || (worker.availableTokens !== null && decision.estimatedTokens > worker.availableTokens))
        throw workerUnavailable();
    }
    await decideChat(tx, leader, clanId, messageId, decision);
    // If validation or a lock wait consumed the lease, roll back the decision before another runner can take over.
    const [finished] = await tx
      .update(chats)
      .set({ ...clearLease, cloudRetryAt: null, cloudAttempts: 0 })
      .where(heldLease(claim))
      .returning({ clanId: chats.clanId });
    if (!finished) throw new ApiError(409, 'CHAT_CONFLICT', 'The cloud orchestrator lease expired');
    return true;
  });
}

function workerUnavailable() {
  return new ApiError(409, 'CHAT_CONFLICT', 'The selected worker is no longer available');
}

export async function retryCloudChat(db: WorkspaceDb, claim: CloudChatClaim): Promise<boolean> {
  return db.transaction(async (tx) => {
    const seconds = Math.min(120, 5 * 2 ** Math.min(claim.attempt - 1, 5));
    const [released] = await tx
      .update(chats)
      .set({
        cloudLeaseId: null,
        cloudLeaseExpiresAt: null,
        cloudRetryAt: sql`clock_timestamp() + ${seconds}::integer * interval '1 second'`,
      })
      .where(heldLease(claim))
      .returning({ clanId: chats.clanId });
    if (!released) return false;
    await tx.update(chatMessages).set({ pickedAt: null }).where(eq(chatMessages.id, claim.messageId));
    return true;
  });
}

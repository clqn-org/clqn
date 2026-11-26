import { type Actor, ApiError } from '@clqn/shared';
import { and, eq, exists, inArray, notInArray, sql } from 'drizzle-orm';
import { requireClan, requirePersonal, type WorkspaceDb } from '../lib/access.js';
import { chatBackups, chats } from './chat.js';
import { agents, credentials, memberships } from './schema.js';

export const liveChatLease = sql<boolean>`coalesce(${chats.leaseExpiresAt} > clock_timestamp(), false)
  and exists (select 1 from credentials c where c.agent_id = chats.lease_agent_id)`;

async function lockChatHost(db: WorkspaceDb, clanId: string) {
  const [chat] = await db.select().from(chats).where(eq(chats.clanId, clanId)).for('update');
  if (!chat) throw new ApiError(404, 'NOT_FOUND', 'Session not found');
  return chat;
}

// Keep the last lease ID as a fence against an in-flight heartbeat from a removed host.
async function expireHostLease(db: WorkspaceDb, clanId: string, ownerIds: string[]) {
  if (!ownerIds.length) return;
  const holder = db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, chats.leaseAgentId), inArray(agents.ownerId, ownerIds)));
  await db
    .update(chats)
    .set({ leaseExpiresAt: null })
    .where(and(eq(chats.clanId, clanId), exists(holder)));
}

async function requireHostLeader(db: WorkspaceDb, actor: Actor, clanId: string) {
  requirePersonal(actor);
  if ((await requireClan(db, actor, clanId, 'share')).role !== 'leader')
    throw new ApiError(403, 'FORBIDDEN', 'Only the clan leader can manage backup hosts');
}

export async function listChatBackups(db: WorkspaceDb, actor: Actor, clanId: string) {
  await requireHostLeader(db, actor, clanId);
  const rows = await db
    .select({ userId: chatBackups.userId })
    .from(chatBackups)
    .where(eq(chatBackups.clanId, clanId))
    .orderBy(chatBackups.userId);
  return { userIds: rows.map(({ userId }) => userId) };
}

export async function setChatBackups(db: WorkspaceDb, actor: Actor, clanId: string, userIds: string[]) {
  await requireHostLeader(db, actor, clanId);
  const ids = [...new Set(userIds.map((id) => id.toLowerCase()))].sort();
  if (ids.length) {
    const targets = await db
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.clanId, clanId), inArray(memberships.userId, ids)))
      .orderBy(memberships.userId)
      .for('share');
    if (targets.length !== ids.length) throw new ApiError(404, 'NOT_FOUND', 'Member not found');
    if (targets.some(({ role }) => role !== 'member'))
      throw new ApiError(400, 'INVALID_REQUEST', 'Choose other clan members as backups');
    await db.insert(chats).values({ clanId, hostId: actor.id }).onConflictDoNothing();
  }
  const [chat] = await db.select({ clanId: chats.clanId }).from(chats).where(eq(chats.clanId, clanId)).for('update');
  if (!chat) return { userIds: [] };
  const removed = await db
    .delete(chatBackups)
    .where(and(eq(chatBackups.clanId, clanId), ids.length ? notInArray(chatBackups.userId, ids) : undefined))
    .returning({ userId: chatBackups.userId });
  if (ids.length)
    await db
      .insert(chatBackups)
      .values(ids.map((userId) => ({ clanId, userId })))
      .onConflictDoNothing();
  await expireHostLease(
    db,
    clanId,
    removed.map(({ userId }) => userId),
  );
  return { userIds: ids };
}

export async function isChatBackup(db: WorkspaceDb, clanId: string, userId?: string) {
  const [backup] = await db
    .select({ userId: chatBackups.userId })
    .from(chatBackups)
    .where(and(eq(chatBackups.clanId, clanId), userId ? eq(chatBackups.userId, userId) : undefined))
    .limit(1);
  return Boolean(backup);
}

// Call under the departing member's membership lock, before deleting the membership.
export async function removeChatBackup(db: WorkspaceDb, clanId: string, userId: string) {
  if (!(await isChatBackup(db, clanId, userId))) return;
  await lockChatHost(db, clanId);
  await db.delete(chatBackups).where(and(eq(chatBackups.clanId, clanId), eq(chatBackups.userId, userId)));
  await expireHostLease(db, clanId, [userId]);
}

export async function transferChatHost(db: WorkspaceDb, clanId: string, formerLeader: string, newLeader: string) {
  // Updating the chat first serializes the nomination and lease changes with other chat hosts.
  await db.update(chats).set({ hostId: newLeader }).where(eq(chats.clanId, clanId));
  await db.delete(chatBackups).where(and(eq(chatBackups.clanId, clanId), eq(chatBackups.userId, newLeader)));
  await expireHostLease(db, clanId, [formerLeader]);
}

async function requireChatHost(db: WorkspaceDb, actor: Actor, clanId: string, tokenHash: string) {
  const membership = await requireClan(db, actor, clanId, 'share');
  const forbidden = () => new ApiError(403, 'FORBIDDEN', 'The leader’s or nominated backup’s orchestrator is required');
  if (!actor.agentId) throw forbidden();
  const chat = await lockChatHost(db, clanId);
  if (membership.role !== 'leader' && !(await isChatBackup(db, clanId, actor.id))) throw forbidden();
  // Credential rotation locks the agent before its credentials. Use that order before setting the lease's agent FK.
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.id, actor.agentId),
        eq(agents.ownerId, actor.id),
        eq(agents.clanId, clanId),
        eq(agents.role, 'orchestrator'),
      ),
    )
    .for('key share');
  if (!agent) throw forbidden();
  const [credential] = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(and(eq(credentials.agentId, agent.id), eq(credentials.tokenHash, tokenHash)))
    .for('share');
  if (!credential) throw forbidden();
  const [status] = await db.select({ live: liveChatLease }).from(chats).where(eq(chats.clanId, clanId));
  return { chat, agentId: agent.id, leader: membership.role === 'leader', live: status!.live };
}

export async function requireChatLease(
  db: WorkspaceDb,
  actor: Actor,
  clanId: string,
  tokenHash: string,
  leaseId: string | undefined,
) {
  const { chat, agentId, leader, live } = await requireChatHost(db, actor, clanId, tokenHash);
  if (!leaseId && leader && !live && !(await isChatBackup(db, clanId))) return;
  if (!leaseId || !live || chat.leaseAgentId !== agentId || chat.leaseId !== leaseId)
    throw new ApiError(409, 'CHAT_LEASE_LOST', 'This orchestrator no longer holds the active chat lease');
}

export async function updateChatLease(
  db: WorkspaceDb,
  actor: Actor,
  clanId: string,
  tokenHash: string,
  leaseId: string,
  action: 'heartbeat' | 'release',
  renew = false,
) {
  const { chat, agentId, live } = await requireChatHost(db, actor, clanId, tokenHash);
  const matches = chat.leaseAgentId === agentId && chat.leaseId === leaseId;
  if (action === 'release') {
    if (matches && live) await db.update(chats).set({ leaseExpiresAt: null }).where(eq(chats.clanId, clanId));
    return { active: false };
  }
  // Renewal cannot recreate a lease after it expired or another process took over and released it.
  if ((live && !matches) || (!live && (matches || renew))) return { active: false };
  await db
    .update(chats)
    .set({ leaseAgentId: agentId, leaseId, leaseExpiresAt: sql`clock_timestamp() + interval '45 seconds'` })
    .where(eq(chats.clanId, clanId));
  return { active: true };
}

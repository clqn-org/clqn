import { type Actor, ApiError } from '@clqn/shared';
import { and, eq, sql } from 'drizzle-orm';
import { requireClan, requirePersonal, type WorkspaceDb } from '../lib/access.js';
import { chats } from './chat.js';
import { agents, credentials, memberships } from './schema.js';

export const liveChatLease = sql<boolean>`coalesce(${chats.leaseExpiresAt} > clock_timestamp(), false)
  and exists (select 1 from credentials c where c.agent_id = chats.lease_agent_id)`;

async function lockChatHost(db: WorkspaceDb, clanId: string) {
  const [chat] = await db.select().from(chats).where(eq(chats.clanId, clanId)).for('update');
  if (!chat) throw new ApiError(404, 'NOT_FOUND', 'Session not found');
  return chat;
}

// Keep the last pair as a fence so an in-flight heartbeat cannot undo release.
async function changeBackup(db: WorkspaceDb, chat: typeof chats.$inferSelect, backupUserId: string | null) {
  if (chat.backupUserId === backupUserId) return;
  const [holder] =
    chat.backupUserId && chat.leaseAgentId
      ? await db.select({ ownerId: agents.ownerId }).from(agents).where(eq(agents.id, chat.leaseAgentId))
      : [];
  await db
    .update(chats)
    .set({ backupUserId, ...(holder?.ownerId === chat.backupUserId ? { leaseExpiresAt: null } : {}) })
    .where(eq(chats.clanId, chat.clanId));
}

export async function nominateChatBackup(db: WorkspaceDb, actor: Actor, clanId: string, userId: string | null) {
  requirePersonal(actor);
  if ((await requireClan(db, actor, clanId, 'share')).role !== 'leader')
    throw new ApiError(403, 'FORBIDDEN', 'Only the clan leader can choose the backup orchestrator');
  if (userId) {
    const [target] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.clanId, clanId), eq(memberships.userId, userId)))
      .for('share');
    if (!target) throw new ApiError(404, 'NOT_FOUND', 'Member not found');
    if (target.role !== 'member') throw new ApiError(400, 'INVALID_REQUEST', 'Choose another clan member as backup');
  }
  await changeBackup(db, await lockChatHost(db, clanId), userId);
  return { backupUserId: userId };
}

// Call under the departing member's membership lock, before deleting the membership.
export async function removeChatBackup(db: WorkspaceDb, clanId: string, userId: string) {
  const [chat] = await db
    .select()
    .from(chats)
    .where(and(eq(chats.clanId, clanId), eq(chats.backupUserId, userId)))
    .for('update');
  if (chat) await changeBackup(db, chat, null);
}

async function requireChatHost(db: WorkspaceDb, actor: Actor, clanId: string, tokenHash: string) {
  const membership = await requireClan(db, actor, clanId, 'share');
  const forbidden = () => new ApiError(403, 'FORBIDDEN', 'The leader’s or nominated backup’s orchestrator is required');
  if (!actor.agentId) throw forbidden();
  const chat = await lockChatHost(db, clanId);
  if (membership.role !== 'leader' && chat.backupUserId !== actor.id) throw forbidden();
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
  if (!leaseId && leader && !chat.backupUserId && !live) return;
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
) {
  const { chat, agentId, live } = await requireChatHost(db, actor, clanId, tokenHash);
  const matches = chat.leaseAgentId === agentId && chat.leaseId === leaseId;
  if (action === 'release') {
    if (matches && live) await db.update(chats).set({ leaseExpiresAt: null }).where(eq(chats.clanId, clanId));
    return { active: false };
  }
  // A live lease can only be renewed by its holder. An expired or released ID cannot be renewed.
  if ((live && !matches) || (!live && matches)) return { active: false };
  await db
    .update(chats)
    .set({ leaseAgentId: agentId, leaseId, leaseExpiresAt: sql`clock_timestamp() + interval '45 seconds'` })
    .where(eq(chats.clanId, clanId));
  return { active: true };
}

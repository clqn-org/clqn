import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  type Actor,
  type Agent,
  ApiError,
  type Clan,
  type PageQuery,
  type PendingInvitation,
  type WorkerModel,
} from '@clqn/shared';
import { and, count, desc, eq, gt, inArray, isNull, sql as query, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { appendEvent, lockClan, requireClan, requirePersonal } from '../lib/access.js';
import { resourceFilter, rethrowAliasConflict } from '../lib/aliases.js';
import { limitReached, limits } from '../lib/limits.js';
import { chats } from './chat.js';
import { isChatBackup, removeChatBackup, transferChatHost } from './chat-host.js';
import { contextEntries, contextRevisions } from './context.js';
import * as schema from './schema.js';
import { tasks } from './tasks.js';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export type Member = { userId: string; email: string; role: 'leader' | 'member'; createdAt: string };
export interface WorkspaceStore {
  createInvitation(
    userId: string,
    clanId: string,
    email: string,
  ): Promise<{ code: string; clanId: string; email: string; expiresAt: string } | undefined>;
  listInvitations(actor: Actor, page: PageQuery): Promise<PendingInvitation[]>;
  joinInvitation(actor: Actor, reference: string | { clanId: string }): Promise<Clan | undefined>;
  registerAgent(
    actor: Actor,
    clanId: string,
    name: string,
    role?: Agent['role'],
    alias?: string,
  ): Promise<{ agent: Agent; token: string }>;
  setAgentAlias(actor: Actor, clanId: string, reference: string, alias: string): Promise<Agent>;
  resetAgentCredentials(
    actor: Actor,
    clanId: string,
    reference: string,
    reissue: boolean,
  ): Promise<{ agent: Agent; token?: string }>;
  reportWorkerModels(
    actor: Actor,
    tokenHash: string,
    models: WorkerModel[] | null,
  ): Promise<{ models: WorkerModel[] | null }>;
  revokeToken(tokenHash: string): Promise<boolean>;
  listAgents(
    actor: Actor,
    clanId: string,
    page?: PageQuery,
  ): Promise<(Agent & { active: boolean; allowedModels: string[] | null; availableModels?: WorkerModel[] | null })[]>;
  agentStatus(actor: Actor): Promise<Agent | undefined>;
  authenticate(tokenHash: string): Promise<Actor | undefined>;
  createClan(userId: string, name: string): Promise<Clan>;
  listClans(userId: string, page?: PageQuery, clanId?: string): Promise<Clan[]>;
  members(userId: string, clanId: string, page?: PageQuery): Promise<Member[] | undefined>;
  removeMember(actor: Actor, clanId: string, userId: string): Promise<void>;
  transferLeadership(actor: Actor, clanId: string, userId: string): Promise<void>;
  deleteClan(actor: Actor, clanId: string): Promise<{ id: string; slug: string }[]>;
}

const pendingFor = (email: string) =>
  and(
    eq(schema.invitations.email, email),
    isNull(schema.invitations.consumedAt),
    gt(schema.invitations.expiresAt, query`now()`),
  );

export function createStore(url: string, poolSize = 10) {
  const sql = postgres(url, { max: poolSize });
  const db = drizzle(sql);
  const clanView = (clan: typeof schema.clans.$inferSelect): Clan => ({
    ...clan,
    createdAt: clan.createdAt.toISOString(),
  });
  const agentView = ({ availableModels: _availableModels, ...agent }: typeof schema.agents.$inferSelect): Agent => ({
    ...agent,
    createdAt: agent.createdAt.toISOString(),
  });
  async function revokeCredential(filter: SQL) {
    return db.transaction(async (tx) => {
      const [target] = await tx
        .select({
          agentId: schema.credentials.agentId,
          userId: schema.credentials.userId,
          clanId: schema.agents.clanId,
        })
        .from(schema.credentials)
        .leftJoin(schema.agents, eq(schema.agents.id, schema.credentials.agentId))
        .where(filter);
      if (!target) return false;
      if (target.agentId && target.clanId) {
        // Match model reports and member removal: membership, agent, then credential.
        await tx
          .select({ userId: schema.memberships.userId })
          .from(schema.memberships)
          .where(and(eq(schema.memberships.clanId, target.clanId), eq(schema.memberships.userId, target.userId)))
          .for('share');
        await tx
          .select({ id: schema.agents.id })
          .from(schema.agents)
          .where(eq(schema.agents.id, target.agentId))
          .for('update');
      }
      const [revoked] = await tx
        .delete(schema.credentials)
        .where(filter)
        .returning({ agentId: schema.credentials.agentId });
      if (revoked?.agentId)
        await tx.update(schema.agents).set({ availableModels: null }).where(eq(schema.agents.id, revoked.agentId));
      return !!revoked;
    });
  }
  const store: WorkspaceStore = {
    async authenticate(tokenHash) {
      const [result] = await db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          agentId: schema.credentials.agentId,
          clanId: schema.agents.clanId,
        })
        .from(schema.credentials)
        .innerJoin(schema.users, eq(schema.credentials.userId, schema.users.id))
        .leftJoin(schema.agents, eq(schema.credentials.agentId, schema.agents.id))
        .where(eq(schema.credentials.tokenHash, tokenHash));
      if (!result) return undefined;
      if (!result.agentId) return { id: result.id, email: result.email };
      if (!result.clanId) return undefined;
      const actor = { id: result.id, email: result.email, agentId: result.agentId, clanId: result.clanId };
      try {
        await requireClan(db, actor, actor.clanId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return undefined;
        throw error;
      }
      return actor;
    },
    async registerAgent(actor, clanId, name, role = 'worker', alias) {
      requirePersonal(actor);
      const token = `clqn_${randomBytes(32).toString('base64url')}`;
      try {
        return await db.transaction(async (tx) => {
          const membership = await requireClan(tx, actor, clanId, 'share');
          if (role === 'orchestrator' && membership.role !== 'leader') {
            // Recheck nominations after taking the chat lock so concurrent edits cannot authorize a stale backup.
            await tx.select({ clanId: chats.clanId }).from(chats).where(eq(chats.clanId, clanId)).for('share');
            if (!(await isChatBackup(tx, clanId, actor.id)))
              throw new ApiError(403, 'FORBIDDEN', 'Only the leader or nominated backup can register an orchestrator');
          }
          const [agent] = await tx
            .insert(schema.agents)
            .values({ clanId, ownerId: actor.id, name, role, alias })
            .returning();
          if (!agent) throw new Error('Agent creation returned no row');
          // Count after inserting, under the clan lock, so concurrent registrations cannot exceed the cap.
          await lockClan(tx, clanId);
          const [owned] = await tx
            .select({ n: count() })
            .from(schema.agents)
            .where(and(eq(schema.agents.clanId, clanId), eq(schema.agents.ownerId, actor.id)));
          if (owned!.n > limits.agentsPerMember)
            throw limitReached(`You can register at most ${limits.agentsPerMember} agents in a clan`);
          await tx
            .insert(schema.credentials)
            .values({ userId: actor.id, agentId: agent.id, tokenHash: hashToken(token) });
          await appendEvent(tx, { clanId, actorId: actor.id, type: 'agent.registered', resourceId: agent.id });
          return { agent: agentView(agent), token };
        });
      } catch (error) {
        const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
        if (cause?.code === '23505' && cause.constraint_name === 'agents_one_orchestrator_per_owner') {
          throw new ApiError(409, 'ORCHESTRATOR_EXISTS', 'You already have an orchestrator in this clan');
        }
        rethrowAliasConflict(error);
      }
    },
    async setAgentAlias(actor, clanId, reference, alias) {
      requirePersonal(actor);
      return db
        .transaction(async (tx) => {
          await requireClan(tx, actor, clanId);
          const [agent] = await tx
            .select()
            .from(schema.agents)
            .where(resourceFilter(schema.agents, clanId, reference))
            .for('update');
          if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
          if (agent.ownerId !== actor.id)
            throw new ApiError(403, 'FORBIDDEN', 'Only the registered owner can rename an agent');
          if (agent.alias === alias) return agentView(agent);
          const [updated] = await tx
            .update(schema.agents)
            .set({ alias })
            .where(eq(schema.agents.id, agent.id))
            .returning();
          await appendEvent(tx, { clanId, actorId: actor.id, type: 'agent.alias_changed', resourceId: agent.id });
          return agentView(updated!);
        })
        .catch(rethrowAliasConflict);
    },
    async resetAgentCredentials(actor, clanId, reference, reissue) {
      requirePersonal(actor);
      return db.transaction(async (tx) => {
        const membership = await requireClan(tx, actor, clanId, 'share');
        const [agent] = await tx
          .select()
          .from(schema.agents)
          .where(resourceFilter(schema.agents, clanId, reference))
          .for('update');
        if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
        // Owners revoke or rotate; the leader may revoke any agent but never receives another member's token.
        if (agent.ownerId !== actor.id && (reissue || membership.role !== 'leader'))
          throw new ApiError(403, 'FORBIDDEN', 'Only the registered owner or the clan leader can revoke an agent');
        await tx.delete(schema.credentials).where(eq(schema.credentials.agentId, agent.id));
        if (agent.availableModels)
          await tx.update(schema.agents).set({ availableModels: null }).where(eq(schema.agents.id, agent.id));
        const token = reissue ? `clqn_${randomBytes(32).toString('base64url')}` : undefined;
        if (token)
          await tx
            .insert(schema.credentials)
            .values({ userId: agent.ownerId, agentId: agent.id, tokenHash: hashToken(token) });
        await appendEvent(tx, {
          clanId,
          actorId: actor.id,
          type: reissue ? 'agent.token_rotated' : 'agent.revoked',
          resourceId: agent.id,
        });
        return token ? { agent: agentView(agent), token } : { agent: agentView(agent) };
      });
    },
    async reportWorkerModels(actor, tokenHash, models) {
      const { agentId, clanId } = actor;
      const forbidden = () => new ApiError(403, 'FORBIDDEN', 'An active worker credential is required');
      if (!agentId || !clanId) throw forbidden();
      return db.transaction(async (tx) => {
        await requireClan(tx, actor, clanId, 'share');
        const [agent] = await tx
          .select({ id: schema.agents.id })
          .from(schema.agents)
          .where(
            and(
              eq(schema.agents.id, agentId),
              eq(schema.agents.clanId, clanId),
              eq(schema.agents.ownerId, actor.id),
              eq(schema.agents.role, 'worker'),
            ),
          )
          .for('update');
        if (!agent) throw forbidden();
        const [credential] = await tx
          .select({ id: schema.credentials.id })
          .from(schema.credentials)
          .where(
            and(
              eq(schema.credentials.agentId, agentId),
              eq(schema.credentials.userId, actor.id),
              eq(schema.credentials.tokenHash, tokenHash),
            ),
          )
          .for('share');
        if (!credential) throw forbidden();
        await tx.update(schema.agents).set({ availableModels: models }).where(eq(schema.agents.id, agentId));
        return { models };
      });
    },
    async revokeToken(tokenHash) {
      return revokeCredential(eq(schema.credentials.tokenHash, tokenHash));
    },
    async listAgents(actor, clanId, page) {
      await requireClan(db, actor, clanId);
      const rows = await db
        .select({
          agent: schema.agents,
          // Drizzle renders columns unqualified inside sql``, so name the tables explicitly.
          active: query<boolean>`exists (select 1 from credentials c where c.agent_id = agents.id)`,
          // So the orchestrator can pick a model the owner allows.
          allowedModels: query<
            string[] | null
          >`(select cm.settings -> 'allowedModels' from chat_members cm where cm.clan_id = agents.clan_id and cm.user_id = agents.owner_id)`,
        })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.clanId, clanId),
            page?.after
              ? query`(agents.created_at, agents.id) > (select created_at, id from agents where id = ${page.after} and clan_id = ${clanId})`
              : undefined,
          ),
        )
        .orderBy(schema.agents.createdAt, schema.agents.id)
        .limit((page?.limit ?? 100) + 1);
      return rows.map(({ agent, active, allowedModels }) => ({
        ...agentView(agent),
        active,
        allowedModels: allowedModels ?? null,
        availableModels: agent.availableModels,
      }));
    },
    async agentStatus(actor) {
      if (!actor.agentId || !actor.clanId) return undefined;
      await requireClan(db, actor, actor.clanId);
      const [agent] = await db
        .select()
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.id, actor.agentId),
            eq(schema.agents.ownerId, actor.id),
            eq(schema.agents.clanId, actor.clanId),
          ),
        );
      return agent ? agentView(agent) : undefined;
    },
    async createClan(userId, name) {
      return db.transaction(async (tx) => {
        // Lock the user so concurrent creations count each other.
        await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).for('update');
        const [created] = await tx.select({ n: count() }).from(schema.clans).where(eq(schema.clans.createdBy, userId));
        if (created!.n >= limits.clansPerUser)
          throw limitReached(`You can create at most ${limits.clansPerUser} clans`);
        const [clan] = await tx.insert(schema.clans).values({ name, createdBy: userId }).returning();
        if (!clan) throw new Error('Clan creation returned no row');
        await tx.insert(schema.memberships).values({ clanId: clan.id, userId, role: 'leader' });
        await appendEvent(tx, { clanId: clan.id, actorId: userId, type: 'clan.created' });
        return clanView(clan);
      });
    },
    async createInvitation(userId, clanId, email) {
      return db.transaction(async (tx) => {
        const [leader] = await tx
          .select()
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.clanId, clanId),
              eq(schema.memberships.userId, userId),
              eq(schema.memberships.role, 'leader'),
            ),
          )
          .for('share');
        if (!leader) return undefined;
        const code = `clqn_inv_${randomBytes(32).toString('base64url')}`;
        const [invitation] = await tx
          .insert(schema.invitations)
          .values({
            clanId,
            email,
            createdBy: userId,
            codeHash: hashToken(code),
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          })
          .returning();
        if (!invitation) throw new Error('Invitation creation returned no row');
        await appendEvent(tx, { clanId, actorId: userId, type: 'invitation.created' });
        return { code, clanId, email, expiresAt: invitation.expiresAt.toISOString() };
      });
    },
    async listInvitations(actor, page) {
      requirePersonal(actor);
      const invitations = await db
        .selectDistinctOn([schema.invitations.clanId], {
          clanId: schema.invitations.clanId,
          clanName: schema.clans.name,
          expiresAt: schema.invitations.expiresAt,
        })
        .from(schema.invitations)
        .innerJoin(schema.clans, eq(schema.clans.id, schema.invitations.clanId))
        .leftJoin(
          schema.memberships,
          and(eq(schema.memberships.clanId, schema.invitations.clanId), eq(schema.memberships.userId, actor.id)),
        )
        .where(
          and(
            pendingFor(actor.email),
            isNull(schema.memberships.userId),
            page.after ? gt(schema.invitations.clanId, page.after) : undefined,
          ),
        )
        .orderBy(schema.invitations.clanId, desc(schema.invitations.createdAt), schema.invitations.id)
        .limit(page.limit + 1);
      return invitations.map(({ clanId, clanName, expiresAt }) => ({
        clanId,
        clanName,
        expiresAt: expiresAt.toISOString(),
      }));
    },
    async joinInvitation(actor, reference) {
      requirePersonal(actor);
      return db.transaction(async (tx) => {
        const match =
          typeof reference === 'string'
            ? eq(schema.invitations.codeHash, hashToken(reference))
            : eq(schema.invitations.clanId, reference.clanId);
        // Accepting by clan consumes every pending invitation for it, so no duplicate outlives the membership.
        const [invitation] = await tx
          .update(schema.invitations)
          .set({ consumedAt: query`now()` })
          .where(and(match, pendingFor(actor.email)))
          .returning({ clanId: schema.invitations.clanId });
        if (!invitation) return undefined;
        const [membership] = await tx
          .insert(schema.memberships)
          .values({ clanId: invitation.clanId, userId: actor.id })
          .onConflictDoNothing()
          .returning();
        if (!membership) throw new ApiError(409, 'ALREADY_MEMBER', 'You are already a member of this clan');
        await appendEvent(tx, { clanId: invitation.clanId, actorId: actor.id, type: 'member.joined' });
        const [clan] = await tx.select().from(schema.clans).where(eq(schema.clans.id, invitation.clanId));
        if (!clan) throw new Error('Invitation clan not found');
        return clanView(clan);
      });
    },
    async listClans(userId, page, clanId) {
      const rows = await db
        .select({ clan: schema.clans })
        .from(schema.memberships)
        .innerJoin(schema.clans, eq(schema.memberships.clanId, schema.clans.id))
        .where(
          and(
            eq(schema.memberships.userId, userId),
            clanId ? eq(schema.clans.id, clanId) : undefined,
            page?.after
              ? query`(clans.created_at, clans.id) > (
            select c.created_at, c.id from clans c join memberships m on m.clan_id = c.id
            where c.id = ${page.after} and m.user_id = ${userId}
          )`
              : undefined,
          ),
        )
        .orderBy(schema.clans.createdAt, schema.clans.id)
        .limit((page?.limit ?? 100) + 1);
      return rows.map(({ clan }) => clanView(clan));
    },
    async removeMember(actor, clanId, userId) {
      requirePersonal(actor);
      await db.transaction(async (tx) => {
        const [user] = await tx
          .select({ email: schema.users.email })
          .from(schema.users)
          .where(eq(schema.users.id, userId));
        const leaving = userId === actor.id;
        // Lock the actor's row so a concurrent leadership transfer cannot leave a stale leader check.
        const membership = await requireClan(tx, actor, clanId, leaving ? 'update' : 'share');
        if (!leaving && membership.role !== 'leader')
          throw new ApiError(403, 'FORBIDDEN', 'Only the clan leader can remove members');
        // Agent registration and token rotation hold a share lock on this row, so they cannot race the removal.
        const [target] = await tx
          .select()
          .from(schema.memberships)
          .where(and(eq(schema.memberships.clanId, clanId), eq(schema.memberships.userId, userId)))
          .for('update');
        if (!target) throw new ApiError(404, 'NOT_FOUND', 'Member not found');
        if (target.role === 'leader')
          throw new ApiError(409, 'LEADER_REQUIRED', 'The clan leader cannot leave or be removed');
        await removeChatBackup(tx, clanId, userId);
        // Pending invitations must not let removed members reinstate their own access.
        if (user) {
          await tx
            .update(schema.invitations)
            .set({ consumedAt: query`now()` })
            .where(and(eq(schema.invitations.clanId, clanId), pendingFor(user.email)));
        }
        // Delete agent tokens too, so a later invitation cannot revive them.
        const owned = await tx
          .update(schema.agents)
          .set({ availableModels: null })
          .where(and(eq(schema.agents.clanId, clanId), eq(schema.agents.ownerId, userId)))
          .returning({ id: schema.agents.id });
        if (owned.length)
          await tx.delete(schema.credentials).where(
            inArray(
              schema.credentials.agentId,
              owned.map(({ id }) => id),
            ),
          );
        await tx
          .delete(schema.memberships)
          .where(and(eq(schema.memberships.clanId, clanId), eq(schema.memberships.userId, userId)));
        await appendEvent(tx, {
          clanId,
          actorId: actor.id,
          type: leaving ? 'member.left' : 'member.removed',
          resourceId: userId,
        });
      });
    },
    // Deletes the clan and everything scoped to it. Returns the linked repositories so the caller can remove webhooks.
    async deleteClan(actor, clanId) {
      requirePersonal(actor);
      return db.transaction(async (tx) => {
        const membership = await requireClan(tx, actor, clanId, 'update');
        if (membership.role !== 'leader')
          throw new ApiError(403, 'FORBIDDEN', 'Only the clan leader can delete the clan');
        // Lock every membership so agent registration and token rotation wait, then the clan row so
        // concurrent inserts that reference it wait and fail once it is gone.
        await tx.select().from(schema.memberships).where(eq(schema.memberships.clanId, clanId)).for('update');
        await tx.select({ id: schema.clans.id }).from(schema.clans).where(eq(schema.clans.id, clanId)).for('update');
        await lockClan(tx, clanId);
        const agents = tx.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.clanId, clanId));
        // Chats cascade to backups, messages, and token hours; memberships cascade to chat members.
        await tx.delete(chats).where(eq(chats.clanId, clanId));
        await tx.delete(tasks).where(eq(tasks.clanId, clanId));
        await tx.delete(schema.credentials).where(inArray(schema.credentials.agentId, agents));
        await tx.delete(schema.events).where(eq(schema.events.clanId, clanId));
        await tx.delete(schema.agents).where(eq(schema.agents.clanId, clanId));
        await tx.delete(schema.invitations).where(eq(schema.invitations.clanId, clanId));
        const repositories = await tx
          .delete(schema.linkedRepositories)
          .where(eq(schema.linkedRepositories.clanId, clanId))
          .returning({ id: schema.linkedRepositories.id, slug: schema.linkedRepositories.slug });
        await tx.delete(contextRevisions).where(eq(contextRevisions.clanId, clanId));
        await tx.delete(contextEntries).where(eq(contextEntries.clanId, clanId));
        await tx.delete(schema.memberships).where(eq(schema.memberships.clanId, clanId));
        await tx.delete(schema.clans).where(eq(schema.clans.id, clanId));
        return repositories;
      });
    },
    async transferLeadership(actor, clanId, userId) {
      requirePersonal(actor);
      await db.transaction(async (tx) => {
        // Lock the leader row first, so concurrent transfers or removals see the committed role.
        const membership = await requireClan(tx, actor, clanId, 'update');
        if (membership.role !== 'leader')
          throw new ApiError(403, 'FORBIDDEN', 'Only the clan leader can transfer leadership');
        if (userId === actor.id) throw new ApiError(400, 'INVALID_REQUEST', 'You are already the clan leader');
        const [target] = await tx
          .update(schema.memberships)
          .set({ role: 'leader' })
          .where(and(eq(schema.memberships.clanId, clanId), eq(schema.memberships.userId, userId)))
          .returning();
        if (!target) throw new ApiError(404, 'NOT_FOUND', 'Member not found');
        await tx
          .update(schema.memberships)
          .set({ role: 'member' })
          .where(and(eq(schema.memberships.clanId, clanId), eq(schema.memberships.userId, actor.id)));
        await transferChatHost(tx, clanId, actor.id, userId);
        // The former leader loses host authority. Other backups keep their own orchestrators.
        await tx
          .update(schema.agents)
          .set({ role: 'worker' })
          .where(
            and(
              eq(schema.agents.clanId, clanId),
              eq(schema.agents.role, 'orchestrator'),
              eq(schema.agents.ownerId, actor.id),
            ),
          );
        await appendEvent(tx, { clanId, actorId: actor.id, type: 'clan.leader_changed', resourceId: userId });
      });
    },
    async members(userId, clanId, page) {
      const [membership] = await db
        .select({ userId: schema.memberships.userId })
        .from(schema.memberships)
        .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.clanId, clanId)));
      if (!membership) return undefined;
      const rows = await db
        .select({
          userId: schema.users.id,
          email: schema.users.email,
          role: schema.memberships.role,
          createdAt: schema.memberships.createdAt,
        })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
        .where(
          and(
            eq(schema.memberships.clanId, clanId),
            page?.after
              ? query`(memberships.created_at, users.id) > (select created_at, user_id from memberships where user_id = ${page.after} and clan_id = ${clanId})`
              : undefined,
          ),
        )
        .orderBy(schema.memberships.createdAt, schema.users.id)
        .limit((page?.limit ?? 100) + 1);
      return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    },
  };
  return {
    store,
    db,
    async provisionUser(email: string) {
      const token = `clqn_${randomBytes(32).toString('base64url')}`;
      const result = await db.transaction(async (tx) => {
        const [user] = await tx
          .insert(schema.users)
          .values({ id: randomUUID(), email })
          .onConflictDoUpdate({
            target: schema.users.email,
            set: { email },
          })
          .returning({ id: schema.users.id, email: schema.users.email });
        if (!user) throw new Error('User creation returned no row');
        const [credential] = await tx
          .insert(schema.credentials)
          .values({ userId: user.id, tokenHash: hashToken(token) })
          .returning({ id: schema.credentials.id });
        if (!credential) throw new Error('Credential creation returned no row');
        return { user, credentialId: credential.id };
      });
      return { ...result, token };
    },
    async revokeCredential(id: string) {
      return revokeCredential(eq(schema.credentials.id, id));
    },
    close: () => sql.end(),
  };
}

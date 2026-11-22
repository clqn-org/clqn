import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type Actor, type Agent, ApiError, type Clan, type User } from '@clqn/shared';
import { and, count, eq, gt, inArray, isNull, sql as query } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { appendEvent, lockClan, requireClan, requirePersonal } from './access.js';
import { resourceFilter, rethrowAliasConflict } from './aliases.js';
import * as schema from './db/schema.js';
import { limitReached, limits } from './limits.js';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export type Member = { userId: string; email: string; role: 'leader' | 'member'; createdAt: string };
export interface WorkspaceStore {
  createInvitation(
    userId: string,
    clanId: string,
    email: string,
  ): Promise<{ code: string; clanId: string; email: string; expiresAt: string } | undefined>;
  joinInvitation(user: User, code: string): Promise<Clan | undefined>;
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
  revokeToken(tokenHash: string): Promise<boolean>;
  listAgents(actor: Actor, clanId: string): Promise<Agent[]>;
  agentStatus(actor: Actor): Promise<Agent | undefined>;
  authenticate(tokenHash: string): Promise<Actor | undefined>;
  createClan(userId: string, name: string): Promise<Clan>;
  listClans(userId: string): Promise<Clan[]>;
  members(userId: string, clanId: string): Promise<Member[] | undefined>;
  removeMember(actor: Actor, clanId: string, userId: string): Promise<void>;
  transferLeadership(actor: Actor, clanId: string, userId: string): Promise<void>;
}

export function createStore(url: string, poolSize = 10) {
  const sql = postgres(url, { max: poolSize });
  const db = drizzle(sql);
  const clanView = (clan: typeof schema.clans.$inferSelect): Clan => ({
    ...clan,
    createdAt: clan.createdAt.toISOString(),
  });
  const agentView = (agent: typeof schema.agents.$inferSelect): Agent => ({
    ...agent,
    createdAt: agent.createdAt.toISOString(),
  });
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
            throw new ApiError(403, 'FORBIDDEN', 'Only the clan leader can register the orchestrator');
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
        if (cause?.code === '23505' && cause.constraint_name === 'agents_one_orchestrator_per_clan') {
          throw new ApiError(409, 'ORCHESTRATOR_EXISTS', 'This clan already has an orchestrator');
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
    async revokeToken(tokenHash) {
      const rows = await db
        .delete(schema.credentials)
        .where(eq(schema.credentials.tokenHash, tokenHash))
        .returning({ id: schema.credentials.id });
      return rows.length > 0;
    },
    async listAgents(actor, clanId) {
      await requireClan(db, actor, clanId);
      const rows = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.clanId, clanId))
        .orderBy(schema.agents.createdAt, schema.agents.id);
      return rows.map(agentView);
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
          );
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
    async joinInvitation(user, code) {
      return db.transaction(async (tx) => {
        // The conditional update locks and consumes exactly one valid invitation. All writes roll back together.
        const [invitation] = await tx
          .update(schema.invitations)
          .set({ consumedAt: query`now()` })
          .where(
            and(
              eq(schema.invitations.codeHash, hashToken(code)),
              eq(schema.invitations.email, user.email),
              isNull(schema.invitations.consumedAt),
              gt(schema.invitations.expiresAt, query`now()`),
            ),
          )
          .returning();
        if (!invitation) return undefined;
        const [membership] = await tx
          .insert(schema.memberships)
          .values({ clanId: invitation.clanId, userId: user.id })
          .onConflictDoNothing()
          .returning();
        if (!membership) throw new ApiError(409, 'ALREADY_MEMBER', 'You are already a member of this clan');
        await appendEvent(tx, { clanId: invitation.clanId, actorId: user.id, type: 'member.joined' });
        const [clan] = await tx.select().from(schema.clans).where(eq(schema.clans.id, invitation.clanId));
        if (!clan) throw new Error('Invitation clan not found');
        return clanView(clan);
      });
    },
    async listClans(userId) {
      const rows = await db
        .select({ clan: schema.clans })
        .from(schema.memberships)
        .innerJoin(schema.clans, eq(schema.memberships.clanId, schema.clans.id))
        .where(eq(schema.memberships.userId, userId))
        .orderBy(schema.clans.createdAt, schema.clans.id);
      return rows.map(({ clan }) => clanView(clan));
    },
    async removeMember(actor, clanId, userId) {
      requirePersonal(actor);
      await db.transaction(async (tx) => {
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
        // Delete agent tokens too, so a later invitation cannot revive them.
        const owned = tx
          .select({ id: schema.agents.id })
          .from(schema.agents)
          .where(and(eq(schema.agents.clanId, clanId), eq(schema.agents.ownerId, userId)));
        await tx.delete(schema.credentials).where(inArray(schema.credentials.agentId, owned));
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
        // Only a leader's agent may orchestrate, and a clan has one orchestrator; free the slot for the new leader.
        await tx
          .update(schema.agents)
          .set({ role: 'worker' })
          .where(and(eq(schema.agents.clanId, clanId), eq(schema.agents.role, 'orchestrator')));
        await appendEvent(tx, { clanId, actorId: actor.id, type: 'clan.leader_changed', resourceId: userId });
      });
    },
    async members(userId, clanId) {
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
        .where(eq(schema.memberships.clanId, clanId))
        .orderBy(schema.memberships.createdAt, schema.users.id);
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
      const rows = await db
        .delete(schema.credentials)
        .where(eq(schema.credentials.id, id))
        .returning({ id: schema.credentials.id });
      return rows.length > 0;
    },
    close: () => sql.end(),
  };
}

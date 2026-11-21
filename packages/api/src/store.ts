import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type Actor, type Agent, ApiError, type Clan, type User } from '@clqn/shared';
import { and, eq, gt, isNull, sql as query } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { appendEvent, requireClan, requirePersonal } from './access.js';
import { resourceFilter, rethrowAliasConflict } from './aliases.js';
import * as schema from './db/schema.js';

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
  listAgents(actor: Actor, clanId: string): Promise<Agent[]>;
  agentStatus(actor: Actor): Promise<Agent | undefined>;
  authenticate(tokenHash: string): Promise<Actor | undefined>;
  createClan(userId: string, name: string): Promise<Clan>;
  listClans(userId: string): Promise<Clan[]>;
  members(userId: string, clanId: string): Promise<Member[] | undefined>;
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
          const membership = await requireClan(tx, actor, clanId);
          if (role === 'orchestrator' && membership.role !== 'leader') {
            throw new ApiError(403, 'FORBIDDEN', 'Only the clan leader can register the orchestrator');
          }
          const [agent] = await tx
            .insert(schema.agents)
            .values({ clanId, ownerId: actor.id, name, role, alias })
            .returning();
          if (!agent) throw new Error('Agent creation returned no row');
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

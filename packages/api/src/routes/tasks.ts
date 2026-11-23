import {
  type Actor,
  ApiError,
  assignTaskSchema,
  createTaskSchema,
  integrationReportSchema,
  repositoryReportSchema,
  setAliasSchema,
  type Task,
  type TaskRepository,
  taskListQuerySchema,
} from '@clqn/shared';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { agents, linkedRepositories, memberships } from '../db/schema.js';
import { tasks } from '../db/tasks.js';
import { appendEvent, requireClan, type WorkspaceDb } from '../lib/access.js';
import { resourceFilter, rethrowAliasConflict } from '../lib/aliases.js';

const taskView = (row: typeof tasks.$inferSelect): Task => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
const missingTask = () => new ApiError(404, 'NOT_FOUND', 'Task not found');
const conflict = () => new ApiError(409, 'TASK_CONFLICT', 'Task state or ownership does not allow this action');
const ownTask = (task: typeof tasks.$inferSelect, actor: Actor) =>
  task.ownerId === actor.id && task.ownerAgentId === (actor.agentId ?? null);

async function requireCoordinator(db: WorkspaceDb, actor: Actor, clanId: string) {
  const membership = await requireClan(db, actor, clanId);
  if (!actor.agentId && membership.role === 'leader') return;
  if (actor.agentId && membership.role === 'leader') {
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
      );
    if (agent) return;
  }
  throw new ApiError(403, 'FORBIDDEN', 'A clan leader or its registered orchestrator is required');
}

export function createTaskRoutes(db: WorkspaceDb) {
  const app = new Hono<{ Variables: { user: Actor } }>();
  app.use(
    '*',
    bodyLimit({
      maxSize: 32 * 1024,
      onError: (c) => c.json({ error: { code: 'INVALID_REQUEST', message: 'Request body is too large' } }, 413),
    }),
  );
  app.get('/', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    await requireClan(db, actor, clanId);
    const query = taskListQuerySchema.safeParse(c.req.query());
    if (!query.success)
      throw new ApiError(
        400,
        'INVALID_REQUEST',
        'Use status, mine=true, a limit between 1 and 200, and a task UUID cursor',
      );
    const { status, mine, limit, after } = query.data;
    // "Mine" is work assigned to this agent or claimed by this exact credential identity.
    const owned = and(
      eq(tasks.ownerId, actor.id),
      actor.agentId ? eq(tasks.ownerAgentId, actor.agentId) : isNull(tasks.ownerAgentId),
    );
    const rows = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.clanId, clanId),
          status ? eq(tasks.status, status) : undefined,
          mine ? (actor.agentId ? or(eq(tasks.assignedAgentId, actor.agentId), owned) : owned) : undefined,
          after
            ? sql`(${tasks.createdAt}, ${tasks.id}) > (select created_at, id from tasks where id = ${after} and clan_id = ${clanId})`
            : undefined,
        ),
      )
      .orderBy(tasks.createdAt, tasks.id)
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const next = rows.length > page.length ? page.at(-1)?.id : undefined;
    return c.json({ tasks: page.map(taskView), ...(next ? { nextCursor: next } : {}) });
  });
  app.get('/:taskId', async (c) => {
    const clanId = c.req.param('clanId')!;
    await requireClan(db, c.get('user'), clanId);
    const filter = resourceFilter(tasks, clanId, c.req.param('taskId'));
    const [row] = await db.select().from(tasks).where(filter);
    if (!row) throw missingTask();
    return c.json(taskView(row));
  });
  app.post('/', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    await requireClan(db, actor, clanId);
    const parsed = createTaskSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ApiError(
        400,
        'INVALID_REQUEST',
        'Provide a valid task description, optional alias and repository details',
      );
    const repository: TaskRepository | null = parsed.data.repository
      ? {
          ...parsed.data.repository,
          headSha: null,
          prNumber: null,
          prUrl: null,
          mergeCommitSha: null,
          state: 'pending',
        }
      : null;
    try {
      const task = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(tasks)
          .values({ clanId, description: parsed.data.description, alias: parsed.data.alias, repository })
          .returning();
        if (!row) throw new Error('Task creation returned no row');
        await appendEvent(tx, {
          clanId,
          actorId: actor.id,
          agentId: actor.agentId ?? null,
          type: 'task.created',
          resourceId: row.id,
        });
        return taskView(row);
      });
      return c.json(task, 201);
    } catch (error) {
      const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
      if (cause?.code === '23505' && cause.constraint_name === 'tasks_repository_branch_idx') {
        throw new ApiError(409, 'TASK_CONFLICT', 'Another task already uses this repository branch');
      }
      rethrowAliasConflict(error);
    }
  });
  app.post('/:taskId/alias', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    await requireClan(db, actor, clanId);
    const filter = resourceFilter(tasks, clanId, c.req.param('taskId'));
    const body = setAliasSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, 'INVALID_REQUEST', 'Provide a valid task alias');
    const task = await db
      .transaction(async (tx) => {
        const [row] = await tx.select().from(tasks).where(filter).for('update');
        if (!row) throw missingTask();
        if (!ownTask(row, actor)) await requireCoordinator(tx, actor, clanId);
        if (row.alias === body.data.alias) return taskView(row);
        const [updated] = await tx
          .update(tasks)
          .set({ alias: body.data.alias, updatedAt: sql`now()` })
          .where(eq(tasks.id, row.id))
          .returning();
        await appendEvent(tx, {
          clanId,
          actorId: actor.id,
          agentId: actor.agentId ?? null,
          type: 'task.alias_changed',
          resourceId: row.id,
        });
        return taskView(updated!);
      })
      .catch(rethrowAliasConflict);
    return c.json(task);
  });
  app.post('/:taskId/assign', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    await requireCoordinator(db, actor, clanId);
    const filter = resourceFilter(tasks, clanId, c.req.param('taskId'));
    const body = assignTaskSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, 'INVALID_REQUEST', 'Provide an agentId');
    const task = await db.transaction(async (tx) => {
      const [agent] = await tx
        .select({ id: agents.id })
        .from(agents)
        .innerJoin(memberships, and(eq(memberships.userId, agents.ownerId), eq(memberships.clanId, agents.clanId)))
        .where(resourceFilter(agents, clanId, body.data.agentId))
        .for('share', { of: agents });
      if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
      const [row] = await tx.select().from(tasks).where(filter).for('update');
      if (!row) throw missingTask();
      if (row.status !== 'open' || (row.assignedAgentId && row.assignedAgentId !== agent.id)) throw conflict();
      if (row.assignedAgentId === agent.id) return taskView(row);
      const [updated] = await tx
        .update(tasks)
        .set({ assignedAgentId: agent.id, updatedAt: sql`now()` })
        .where(eq(tasks.id, row.id))
        .returning();
      await appendEvent(tx, {
        clanId,
        actorId: actor.id,
        agentId: actor.agentId ?? null,
        type: 'task.assigned',
        resourceId: row.id,
      });
      return taskView(updated!);
    });
    return c.json(task);
  });
  app.post('/:taskId/unassign', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    await requireCoordinator(db, actor, clanId);
    const filter = resourceFilter(tasks, clanId, c.req.param('taskId'));
    const body = assignTaskSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, 'INVALID_REQUEST', 'Provide the currently assigned agentId');
    const task = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(tasks).where(filter).for('update');
      if (!row) throw missingTask();
      if (row.status !== 'open' || !row.assignedAgentId) throw conflict();
      const [assigned] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, row.assignedAgentId), resourceFilter(agents, clanId, body.data.agentId)));
      if (!assigned) throw conflict();
      const [updated] = await tx
        .update(tasks)
        .set({ assignedAgentId: null, updatedAt: sql`now()` })
        .where(eq(tasks.id, row.id))
        .returning();
      await appendEvent(tx, {
        clanId,
        actorId: actor.id,
        agentId: actor.agentId ?? null,
        type: 'task.unassigned',
        resourceId: row.id,
      });
      return taskView(updated!);
    });
    return c.json(task);
  });
  app.post('/:taskId/repository', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    await requireClan(db, actor, clanId);
    const filter = resourceFilter(tasks, clanId, c.req.param('taskId'));
    const body = repositoryReportSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      throw new ApiError(400, 'INVALID_REQUEST', 'Provide expectedHeadSha, headSha and optional PR number and URL');
    const task = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(tasks).where(filter).for('update');
      if (!row) throw missingTask();
      if (row.status !== 'claimed' || !ownTask(row, actor) || !row.repository || row.repository.state === 'merged')
        throw conflict();
      if (row.repository.headSha !== body.data.expectedHeadSha) {
        throw new ApiError(409, 'REVISION_CONFLICT', 'Repository head changed; read the task before reporting again');
      }
      // GitHub returns owner/repository casing as created; stored slugs are lowercase.
      const prUrl = body.data.prUrl?.toLowerCase();
      if (body.data.prNumber !== undefined) {
        const expectedUrl = `https://github.com/${row.repository.slug}/pull/${body.data.prNumber}`;
        if (prUrl !== expectedUrl)
          throw new ApiError(400, 'INVALID_REQUEST', 'PR URL must match the task repository and PR number');
        if (row.repository.prNumber && row.repository.prNumber !== body.data.prNumber) throw conflict();
      }
      const repository: TaskRepository = {
        ...row.repository,
        headSha: body.data.headSha,
        prNumber: body.data.prNumber ?? row.repository.prNumber,
        prUrl: prUrl ?? row.repository.prUrl,
        state: body.data.prNumber !== undefined || row.repository.prNumber !== null ? 'open' : 'pushed',
      };
      const [updated] = await tx
        .update(tasks)
        .set({ repository, updatedAt: sql`now()` })
        .where(eq(tasks.id, row.id))
        .returning();
      await appendEvent(tx, {
        clanId,
        actorId: actor.id,
        agentId: actor.agentId ?? null,
        type: 'task.repository_updated',
        resourceId: row.id,
      });
      return taskView(updated!);
    });
    return c.json(task);
  });
  app.post('/:taskId/integration', async (c) => {
    const actor = c.get('user');
    const clanId = c.req.param('clanId')!;
    await requireCoordinator(db, actor, clanId);
    const filter = resourceFilter(tasks, clanId, c.req.param('taskId'));
    const body = integrationReportSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, 'INVALID_REQUEST', 'Provide headSha and mergeCommitSha');
    const task = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(tasks).where(filter).for('update');
      if (!row) throw missingTask();
      if (
        row.status !== 'claimed' ||
        !row.repository ||
        row.repository.prNumber === null ||
        row.repository.headSha !== body.data.headSha
      )
        throw conflict();
      if (row.repository.state === 'merged') {
        if (row.repository.mergeCommitSha !== body.data.mergeCommitSha) throw conflict();
        return taskView(row);
      }
      // Once a linked repository sends pull request events, only its signed webhook marks the task merged.
      const [link] = await tx
        .select({ confirmsMerges: linkedRepositories.confirmsMerges })
        .from(linkedRepositories)
        .where(and(eq(linkedRepositories.clanId, clanId), eq(linkedRepositories.slug, row.repository.slug)));
      if (link?.confirmsMerges) return taskView(row);
      const repository: TaskRepository = {
        ...row.repository,
        state: 'merged',
        mergeCommitSha: body.data.mergeCommitSha,
      };
      const [updated] = await tx
        .update(tasks)
        .set({ repository, updatedAt: sql`now()` })
        .where(eq(tasks.id, row.id))
        .returning();
      await appendEvent(tx, {
        clanId,
        actorId: actor.id,
        agentId: actor.agentId ?? null,
        type: 'task.integrated',
        resourceId: row.id,
      });
      return taskView(updated!);
    });
    return c.json(task);
  });
  for (const action of ['claim', 'release', 'complete'] as const) {
    app.post(`/:taskId/${action}`, async (c) => {
      const actor = c.get('user');
      const clanId = c.req.param('clanId')!;
      const membership = await requireClan(db, actor, clanId);
      const filter = resourceFilter(tasks, clanId, c.req.param('taskId'));
      const body = z
        .object({})
        .strict()
        .safeParse(await c.req.json().catch(() => null));
      if (!body.success) throw new ApiError(400, 'INVALID_REQUEST', 'Expected an empty JSON object');
      const task = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(tasks).where(filter).for('update');
        if (!row) throw missingTask();
        const leaderReset = action === 'release' && !actor.agentId && membership.role === 'leader';
        if (row.status !== (action === 'claim' ? 'open' : 'claimed')) throw conflict();
        if (action === 'claim') {
          if (row.assignedAgentId && row.assignedAgentId !== actor.agentId) throw conflict();
        } else if (!leaderReset && !ownTask(row, actor)) throw conflict();
        if (action === 'release' && row.repository?.state === 'merged')
          throw new ApiError(409, 'TASK_CONFLICT', 'Merged tasks must be completed by their owner, not released');
        if (action === 'complete' && row.repository && row.repository.state !== 'merged')
          throw new ApiError(
            409,
            'TASK_CONFLICT',
            'The pull request must be merged first; for linked repositories, GitHub must confirm the merge',
          );
        const update =
          action === 'claim'
            ? {
                status: 'claimed' as const,
                ownerId: actor.id,
                ownerAgentId: actor.agentId ?? null,
                updatedAt: sql`now()`,
              }
            : action === 'release'
              ? {
                  status: 'open' as const,
                  ownerId: null,
                  ownerAgentId: null,
                  assignedAgentId: null,
                  updatedAt: sql`now()`,
                }
              : { status: 'completed' as const, updatedAt: sql`now()` };
        const [updated] = await tx.update(tasks).set(update).where(eq(tasks.id, row.id)).returning();
        const type = { claim: 'task.claimed', release: 'task.released', complete: 'task.completed' }[action];
        await appendEvent(tx, { clanId, actorId: actor.id, agentId: actor.agentId ?? null, type, resourceId: row.id });
        return taskView(updated!);
      });
      return c.json(task);
    });
  }
  return app;
}

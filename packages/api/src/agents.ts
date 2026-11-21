import { type Actor, ApiError, registerAgentSchema, setAliasSchema } from '@clqn/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { WorkspaceStore } from './store.js';

export function createAgentRoutes(store: WorkspaceStore) {
  const app = new Hono<{ Variables: { user: Actor } }>();
  const smallBody = bodyLimit({
    maxSize: 4096,
    onError: (c) => c.json({ error: { code: 'INVALID_REQUEST', message: 'Request body is too large' } }, 413),
  });
  app.post('/clans/:clanId/agents', smallBody, async (c) => {
    const id = z.uuid().safeParse(c.req.param('clanId'));
    if (!id.success) return c.json({ error: { code: 'NOT_FOUND', message: 'Clan not found' } }, 404);
    const parsed = registerAgentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: { code: 'INVALID_REQUEST', message: 'Provide a valid agent name, role and optional alias' } },
        400,
      );
    return c.json(
      await store.registerAgent(c.get('user'), id.data, parsed.data.name, parsed.data.role, parsed.data.alias),
      201,
    );
  });
  app.post('/clans/:clanId/agents/:agentId/alias', smallBody, async (c) => {
    const parsed = setAliasSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, 'INVALID_REQUEST', 'Provide a valid agent alias');
    return c.json(
      await store.setAgentAlias(c.get('user'), c.req.param('clanId'), c.req.param('agentId'), parsed.data.alias),
    );
  });
  app.get('/clans/:clanId/agents', async (c) => {
    const id = z.uuid().safeParse(c.req.param('clanId'));
    if (!id.success) return c.json({ error: { code: 'NOT_FOUND', message: 'Clan not found' } }, 404);
    return c.json({ agents: await store.listAgents(c.get('user'), id.data) });
  });
  app.get('/agent', async (c) => {
    const agent = await store.agentStatus(c.get('user'));
    if (!agent) return c.json({ error: { code: 'NOT_FOUND', message: 'Agent registration not found' } }, 404);
    return c.json(agent);
  });
  return app;
}

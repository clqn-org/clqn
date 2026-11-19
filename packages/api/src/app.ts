import { createGithubLoginRoutes } from './github-login.js';
import { createRepositoryRoutes, createGithubWebhookRoutes } from './repositories.js';
import { createContextRoutes } from './context.js';
import { createPolicyRoutes } from './policy.js';
import { createTaskRoutes } from './tasks.js';
import { createActivityRoutes } from './activity.js';
import type { WorkspaceDb } from './access.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { VERSION, healthSchema, createClanSchema, createInvitationSchema, joinInvitationSchema, ApiError, registerAgentSchema, type Actor } from '@clqn/shared';
import { requirePersonal } from './access.js';
import { hashToken, type WorkspaceStore } from './store.js';

export function createApp(store?: WorkspaceStore, db?: WorkspaceDb, options: { githubWebhookSecret?: string | undefined; githubClientId?: string | undefined } = {}) {
  if (options.githubWebhookSecret !== undefined && options.githubWebhookSecret.trim().length < 32) {
    throw new Error('GITHUB_WEBHOOK_SECRET must contain at least 32 non-padding characters');
  }
  const app = new Hono<{ Variables: { user: Actor } }>();
  // Liveness only: this endpoint intentionally does not connect to the database.
  app.get('/health', (c) => c.json(healthSchema.parse({ status: 'ok', service: 'clqn-api', version: VERSION })));
  app.route('/hooks/github', createGithubWebhookRoutes(db, options.githubWebhookSecret));
  app.route('/auth/github', createGithubLoginRoutes(db, options.githubClientId));
  app.use('/v1/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const header = c.req.header('authorization');
    const token = header?.match(/^Bearer (clqn_[A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) return c.json({ error: { code: 'UNAUTHORIZED', message: 'A valid bearer credential is required' } }, 401);
    if (!store) return c.json({ error: { code: 'UNAVAILABLE', message: 'Database is not configured' } }, 503);
    const user = await store.authenticate(hashToken(token));
    if (!user) return c.json({ error: { code: 'UNAUTHORIZED', message: 'A valid bearer credential is required' } }, 401);
    if (user.agentId) {
      const clanPath = c.req.path.match(/^\/v1\/clans\/([^/]+)/);
      if (clanPath && clanPath[1] !== user.clanId) return c.json({ error: { code: 'NOT_FOUND', message: 'Clan not found' } }, 404);
      if (c.req.method === 'POST' && (c.req.path === '/v1/clans' || c.req.path === '/v1/invitations/join' ||
          /^\/v1\/clans\/[^/]+\/(invitations|agents)$/.test(c.req.path))) requirePersonal(user);
    }
    c.set('user', user);
    await next();
  });
  app.get('/v1/me', (c) => c.json(c.get('user')));
  app.get('/v1/clans', async (c) => {
    const actor = c.get('user');
    const clans = await store!.listClans(actor.id);
    return c.json({ clans: actor.agentId ? clans.filter((clan) => clan.id === actor.clanId) : clans });
  });
  app.post('/v1/clans', bodyLimit({ maxSize: 4096, onError: (c) =>
    c.json({ error: { code: 'INVALID_REQUEST', message: 'Request body is too large' } }, 413) }), async (c) => {
    const raw = await c.req.text();
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return c.json({ error: { code: 'INVALID_REQUEST', message: 'Expected a JSON body' } }, 400); }
    const parsed = createClanSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: { code: 'INVALID_REQUEST', message: 'Provide a clan name between 1 and 100 characters' } }, 400);
    return c.json(await store!.createClan(c.get('user').id, parsed.data.name), 201);
  });
  const invitationBodyLimit = bodyLimit({ maxSize: 4096, onError: (c) =>
    c.json({ error: { code: 'INVALID_REQUEST', message: 'Request body is too large' } }, 413) });
  app.post('/v1/clans/:clanId/invitations', invitationBodyLimit, async (c) => {
    const id = z.uuid().safeParse(c.req.param('clanId'));
    if (!id.success) return c.json({ error: { code: 'NOT_FOUND', message: 'Clan not found' } }, 404);
    const parsed = createInvitationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'INVALID_REQUEST', message: 'Provide a valid email address' } }, 400);
    const invitation = await store!.createInvitation(c.get('user').id, id.data, parsed.data.email);
    if (!invitation) return c.json({ error: { code: 'NOT_FOUND', message: 'Clan not found' } }, 404);
    return c.json(invitation, 201);
  });
  app.post('/v1/invitations/join', invitationBodyLimit, async (c) => {
    const parsed = joinInvitationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'INVALID_REQUEST', message: 'Provide a valid invitation code' } }, 400);
    const clan = await store!.joinInvitation(c.get('user'), parsed.data.code);
    if (!clan) return c.json({ error: { code: 'NOT_FOUND', message: 'Invitation not found' } }, 404);
    return c.json(clan);
  });
  app.post('/v1/clans/:clanId/agents', invitationBodyLimit, async (c) => {
    const id = z.uuid().safeParse(c.req.param('clanId'));
    if (!id.success) return c.json({ error: { code: 'NOT_FOUND', message: 'Clan not found' } }, 404);
    const parsed = registerAgentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'INVALID_REQUEST', message: 'Provide an agent name between 1 and 100 characters' } }, 400);
    return c.json(await store!.registerAgent(c.get('user'), id.data, parsed.data.name, parsed.data.role), 201);
  });
  app.get('/v1/clans/:clanId/agents', async (c) => {
    const id = z.uuid().safeParse(c.req.param('clanId'));
    if (!id.success) return c.json({ error: { code: 'NOT_FOUND', message: 'Clan not found' } }, 404);
    return c.json({ agents: await store!.listAgents(c.get('user'), id.data) });
  });
  app.get('/v1/agent', async (c) => {
    const agent = await store!.agentStatus(c.get('user'));
    if (!agent) return c.json({ error: { code: 'NOT_FOUND', message: 'Agent registration not found' } }, 404);
    return c.json(agent);
  });
  app.get('/v1/clans/:clanId/members', async (c) => {
    const id = z.uuid().safeParse(c.req.param('clanId'));
    const members = id.success ? await store!.members(c.get('user').id, id.data) : undefined;
    if (!members) return c.json({ error: { code: 'NOT_FOUND', message: 'Clan not found' } }, 404);
    return c.json({ members });
  });
  if (db) {
    app.route('/v1/clans/:clanId/repositories', createRepositoryRoutes(db, options.githubWebhookSecret));
    app.route('/v1/clans/:clanId/policy', createPolicyRoutes(db));
    app.route('/v1/clans/:clanId/context', createContextRoutes(db));
    app.route('/v1/clans/:clanId/tasks', createTaskRoutes(db));
    app.route('/v1/clans/:clanId', createActivityRoutes(db));
  }
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));
  app.onError((error, c) => {
    if (error instanceof ApiError && [400, 403, 404, 409, 503].includes(error.status)) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400 | 403 | 404 | 409 | 503);
    }
    // Database errors may contain SQL parameters. Never log request credentials or user data.
    console.error('API request failed', { name: error.name });
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } }, 500);
  });
  return app;
}

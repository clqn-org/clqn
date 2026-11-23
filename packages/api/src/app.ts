import { type Actor, ApiError } from '@clqn/shared';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { hashToken, type WorkspaceStore } from './db/store.js';
import type { WorkspaceDb } from './lib/access.js';
import { requirePersonal } from './lib/access.js';
import { createRateLimiter } from './lib/rate-limit.js';
import { createActivityRoutes } from './routes/activity.js';
import { createAgentRoutes } from './routes/agents.js';
import { createClanRoutes } from './routes/clans.js';
import { createContextRoutes } from './routes/context.js';
import { createGithubLoginRoutes } from './routes/github-login.js';
import { createHealthRoutes } from './routes/health.js';
import { createIdentityRoutes } from './routes/identity.js';
import { createPolicyRoutes } from './routes/policy.js';
import { createGithubWebhookRoutes, createRepositoryRoutes } from './routes/repositories.js';
import { createTaskRoutes } from './routes/tasks.js';

export function createApp(
  store?: WorkspaceStore,
  db?: WorkspaceDb,
  options: {
    githubWebhookSecret?: string | undefined;
    githubClientId?: string | undefined;
    requestsPerMinute?: number;
  } = {},
) {
  if (options.githubWebhookSecret !== undefined && options.githubWebhookSecret.trim().length < 32) {
    throw new Error('GITHUB_WEBHOOK_SECRET must contain at least 32 non-padding characters');
  }
  const app = new Hono<{ Variables: { user: Actor; tokenHash: string; requestId: string } }>();
  const rateLimit = createRateLimiter(options.requestsPerMinute ?? 300);
  // Echoed as X-Request-Id and in 500 messages so a report can be matched to a log line.
  app.use(requestId({ limitLength: 64 }));
  app.route('/', createHealthRoutes(db));
  app.route('/hooks/github', createGithubWebhookRoutes(db, options.githubWebhookSecret));
  app.route('/auth/github', createGithubLoginRoutes(db, options.githubClientId));
  app.use('/v1/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const header = c.req.header('authorization');
    const token = header?.match(/^Bearer (clqn_[A-Za-z0-9_-]{43})$/)?.[1];
    if (!token)
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'A valid bearer credential is required' } }, 401);
    if (!store) return c.json({ error: { code: 'UNAVAILABLE', message: 'Database is not configured' } }, 503);
    const tokenHash = hashToken(token);
    // Check before authenticating so a runaway client cannot exhaust the database pool. Only verified
    // credentials are counted, so unknown tokens cannot fill the table and switch limits off for real ones.
    const retryAfter = rateLimit.retryAfter(tokenHash);
    if (retryAfter) {
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: { code: 'RATE_LIMITED', message: 'Too many requests; try again later' } }, 429);
    }
    const user = await store.authenticate(tokenHash);
    if (!user)
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'A valid bearer credential is required' } }, 401);
    rateLimit.record(tokenHash);
    if (user.agentId) {
      const clanPath = c.req.path.match(/^\/v1\/clans\/([^/]+)/);
      if (clanPath && clanPath[1] !== user.clanId)
        return c.json({ error: { code: 'NOT_FOUND', message: 'Clan not found' } }, 404);
      if (
        c.req.method === 'POST' &&
        (c.req.path === '/v1/clans' ||
          c.req.path === '/v1/invitations/join' ||
          /^\/v1\/clans\/[^/]+\/(invitations|agents)$/.test(c.req.path))
      )
        requirePersonal(user);
    }
    c.set('user', user);
    c.set('tokenHash', tokenHash);
    await next();
  });
  app.route('/v1', createIdentityRoutes(store));
  if (store) {
    app.route('/v1', createClanRoutes(store));
    app.route('/v1', createAgentRoutes(store));
  }
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
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.status as 400 | 403 | 404 | 409 | 503,
      );
    }
    // Database errors may contain SQL parameters. Never log request credentials or user data.
    // One JSON line per failure; Cloud Logging reads severity and message from it.
    const id = c.get('requestId');
    console.error(
      JSON.stringify({
        severity: 'ERROR',
        message: 'API request failed',
        error: error.name,
        requestId: id,
        method: c.req.method,
        route: c.req.routePath,
      }),
    );
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: `An unexpected error occurred (request ID ${id})` } },
      500,
    );
  });
  return app;
}

import { randomBytes, randomUUID } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { eq, lt, sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { WorkspaceDb } from './access.js';
import { credentials, githubLogins, users } from './db/schema.js';
import { createRateLimiter } from './rate-limit.js';
import { hashToken } from './store.js';

const unavailable = () => new Error('GitHub authentication unavailable');
// Fixed destinations, no redirects, bounded requests, and no upstream bodies in errors.
export async function githubRequest(
  path: string,
  body?: Record<string, string>,
  token?: string,
  transport = fetch,
): Promise<unknown> {
  try {
    const response = await transport(`${token ? 'https://api.github.com' : 'https://github.com'}${path}`, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: {
        accept: 'application/json',
        'user-agent': 'clqn',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(body ? { body: new URLSearchParams(body) } : {}),
    });
    if (!response.ok) throw unavailable();
    return await response.json();
  } catch {
    throw unavailable();
  }
}
export function verifiedIdentity(profile: unknown, emails: unknown) {
  const user = z.object({ id: z.number().int().positive().safe() }).parse(profile);
  const addresses = z
    .array(z.object({ email: z.email(), primary: z.boolean(), verified: z.boolean() }))
    .max(100)
    .parse(emails);
  const email = addresses.find((entry) => entry.primary && entry.verified)?.email.toLowerCase();
  if (!email) throw new Error('A verified primary GitHub email is required');
  return { githubId: String(user.id), email };
}
// Cloud Run appends the connecting address to X-Forwarded-For; earlier entries are client-supplied.
// Behind an extra load balancer the last entry is the balancer, so all clients share one limit.
function clientAddress(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
export function createGithubLoginRoutes(db?: WorkspaceDb, clientId?: string, request = githubRequest) {
  const app = new Hono();
  // A bounded, process-local admission guard; deployment-wide edge limits remain necessary.
  // Starts are limited per client so one client cannot lock everyone else out of login.
  const starts = createRateLimiter(10);
  let active = 0;
  app.use('*', async (c, next) => {
    const client = c.req.path.endsWith('/start') ? clientAddress(c) : undefined;
    const retryAfter = client ? starts.retryAfter(client) : undefined;
    if (active >= 10 || retryAfter) {
      c.header('Retry-After', String(retryAfter ?? 60));
      c.header('Cache-Control', 'no-store');
      return c.json({ error: { code: 'RATE_LIMITED', message: 'Please try login again later' } }, 429);
    }
    if (client) starts.record(client);
    active++;
    try {
      await next();
    } finally {
      active--;
    }
  });
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!db || !clientId)
      return c.json({ error: { code: 'UNAVAILABLE', message: 'GitHub login is not configured' } }, 503);
    await next();
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: 1024,
      onError: (c) => c.json({ error: { code: 'INVALID_REQUEST', message: 'Request too large' } }, 413),
    }),
  );
  app.post('/start', async (c) => {
    const result = z
      .object({
        device_code: z.string().min(1).max(200),
        user_code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
        verification_uri: z.literal('https://github.com/login/device'),
        expires_in: z.number().int().positive().max(900),
        interval: z.number().int().positive().max(60),
      })
      .parse(await request('/login/device/code', { client_id: clientId!, scope: 'user:email' }));
    const handle = randomBytes(32).toString('base64url');
    const interval = Math.max(5, result.interval);
    const now = Date.now();
    await db!.delete(githubLogins).where(lt(githubLogins.expiresAt, new Date(now)));
    await db!.insert(githubLogins).values({
      handleHash: hashToken(handle),
      deviceCode: result.device_code,
      expiresAt: new Date(now + result.expires_in * 1000),
      nextPollAt: new Date(now + interval * 1000),
      interval,
    });
    return c.json({
      handle,
      userCode: result.user_code,
      verificationUri: result.verification_uri,
      expiresIn: result.expires_in,
      interval,
    });
  });
  app.post('/poll', async (c) => {
    const input = z
      .object({ handle: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid login handle' } }, 400);
    const key = hashToken(input.data.handle);
    const terminal = async (status: string) => {
      await db!.delete(githubLogins).where(eq(githubLogins.handleHash, key));
      return c.json({ status });
    };
    // Reserve the poll slot in a short transaction. GitHub calls run outside it so slow responses cannot hold pool connections.
    const attempt = await db!.transaction(async (tx) => {
      const [row] = await tx.select().from(githubLogins).where(eq(githubLogins.handleHash, key)).for('update');
      if (!row || row.expiresAt.getTime() <= Date.now()) return undefined;
      if (row.nextPollAt.getTime() > Date.now()) return { ...row, due: false };
      await tx
        .update(githubLogins)
        .set({ nextPollAt: new Date(Date.now() + row.interval * 1000) })
        .where(eq(githubLogins.handleHash, key));
      return { ...row, due: true };
    });
    if (!attempt) return terminal('expired');
    if (!attempt.due) return c.json({ status: 'pending', interval: attempt.interval });
    const response = z
      .object({
        error: z.string().optional(),
        access_token: z.string().min(1).optional(),
        token_type: z.string().optional(),
      })
      .parse(
        await request('/login/oauth/access_token', {
          client_id: clientId!,
          device_code: attempt.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      );
    if (response.error === 'authorization_pending' || response.error === 'slow_down') {
      const interval = Math.min(300, attempt.interval + (response.error === 'slow_down' ? 5 : 0));
      await db!
        .update(githubLogins)
        .set({ interval, nextPollAt: new Date(Date.now() + interval * 1000) })
        .where(eq(githubLogins.handleHash, key));
      return c.json({ status: 'pending', interval });
    }
    if (response.error || !response.access_token || response.token_type !== 'bearer') return terminal('denied');
    let identity: ReturnType<typeof verifiedIdentity>;
    try {
      identity = verifiedIdentity(
        await request('/user', undefined, response.access_token),
        await request('/user/emails', undefined, response.access_token),
      );
    } catch {
      return terminal('denied');
    }
    const result = await db!.transaction(async (tx) => {
      // Consume the attempt exactly once; the credential and the deletion commit together.
      const [current] = await tx.delete(githubLogins).where(eq(githubLogins.handleHash, key)).returning();
      if (!current || current.expiresAt.getTime() <= Date.now()) return { status: 'expired' };
      // Serialize logins for the same identity, even across API instances.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identity.githubId}, 1))`);
      let [user] = await tx.select().from(users).where(eq(users.githubId, identity.githubId));
      if (!user) {
        // Do not adopt operator accounts or other GitHub identities by email.
        [user] = await tx
          .insert(users)
          .values({ id: randomUUID(), ...identity })
          .onConflictDoNothing()
          .returning();
        if (!user) return { status: 'account_conflict' };
      } else {
        // Email changes require deliberate operator reconciliation; stale addresses cannot accept invitations.
        if (user.email !== identity.email) return { status: 'account_conflict' };
      }
      const token = `clqn_${randomBytes(32).toString('base64url')}`;
      await tx.insert(credentials).values({ userId: user.id, tokenHash: hashToken(token) });
      return { status: 'complete', token, user: { id: user.id, email: user.email } };
    });
    return c.json(result);
  });
  app.onError((_error, c) =>
    c.json({ error: { code: 'GITHUB_LOGIN_FAILED', message: 'GitHub login failed; try again' } }, 503),
  );
  return app;
}

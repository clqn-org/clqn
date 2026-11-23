import {
  type Actor,
  ApiError,
  createClanSchema,
  createInvitationSchema,
  joinInvitationSchema,
  transferLeadershipSchema,
} from '@clqn/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { WorkspaceStore } from '../db/store.js';
import { pageResponse, parsePage } from '../lib/pagination.js';

export function createClanRoutes(store: WorkspaceStore) {
  const app = new Hono<{ Variables: { user: Actor } }>();
  const smallBody = bodyLimit({
    maxSize: 4096,
    onError: (c) => c.json({ error: { code: 'INVALID_REQUEST', message: 'Request body is too large' } }, 413),
  });
  app.get('/clans', async (c) => {
    const actor = c.get('user');
    const page = parsePage(c.req.query());
    const clans = await store.listClans(actor.id, page, actor.agentId ? actor.clanId : undefined);
    return c.json(
      pageResponse(
        'clans',
        actor.agentId ? clans.filter((clan) => clan.id === actor.clanId) : clans,
        page.limit,
        (clan) => clan.id,
      ),
    );
  });
  app.post('/clans', smallBody, async (c) => {
    const raw = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Expected a JSON body' } }, 400);
    }
    const parsed = createClanSchema.safeParse(body);
    if (!parsed.success)
      return c.json(
        { error: { code: 'INVALID_REQUEST', message: 'Provide a clan name between 1 and 100 characters' } },
        400,
      );
    return c.json(await store.createClan(c.get('user').id, parsed.data.name), 201);
  });
  app.post('/clans/:clanId/invitations', smallBody, async (c) => {
    const id = z.uuid().safeParse(c.req.param('clanId'));
    if (!id.success) return c.json({ error: { code: 'NOT_FOUND', message: 'Clan not found' } }, 404);
    const parsed = createInvitationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Provide a valid email address' } }, 400);
    const invitation = await store.createInvitation(c.get('user').id, id.data, parsed.data.email);
    if (!invitation) return c.json({ error: { code: 'NOT_FOUND', message: 'Clan not found' } }, 404);
    return c.json(invitation, 201);
  });
  app.post('/invitations/join', smallBody, async (c) => {
    const parsed = joinInvitationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: { code: 'INVALID_REQUEST', message: 'Provide a valid invitation code' } }, 400);
    const clan = await store.joinInvitation(c.get('user'), parsed.data.code);
    if (!clan) return c.json({ error: { code: 'NOT_FOUND', message: 'Invitation not found' } }, 404);
    return c.json(clan);
  });
  app.get('/clans/:clanId/members', async (c) => {
    const id = z.uuid().safeParse(c.req.param('clanId'));
    const page = parsePage(c.req.query());
    const members = id.success ? await store.members(c.get('user').id, id.data, page) : undefined;
    if (!members) return c.json({ error: { code: 'NOT_FOUND', message: 'Clan not found' } }, 404);
    return c.json(pageResponse('members', members, page.limit, (member) => member.userId));
  });
  const emptyBody = async (c: Context) => {
    const body = z
      .object({})
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, 'INVALID_REQUEST', 'Expected an empty JSON object');
  };
  app.post('/clans/:clanId/members/:userId/remove', smallBody, async (c) => {
    await emptyBody(c);
    const userId = z.uuid().safeParse(c.req.param('userId'));
    if (!userId.success) throw new ApiError(404, 'NOT_FOUND', 'Member not found');
    await store.removeMember(c.get('user'), c.req.param('clanId'), userId.data);
    return c.json({ removed: true as const });
  });
  app.post('/clans/:clanId/leave', smallBody, async (c) => {
    await emptyBody(c);
    const actor = c.get('user');
    await store.removeMember(actor, c.req.param('clanId'), actor.id);
    return c.json({ left: true as const });
  });
  app.post('/clans/:clanId/leader', smallBody, async (c) => {
    const body = transferLeadershipSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, 'INVALID_REQUEST', 'Provide the user ID of the new leader');
    await store.transferLeadership(c.get('user'), c.req.param('clanId'), body.data.userId);
    return c.json({ leaderId: body.data.userId });
  });
  return app;
}

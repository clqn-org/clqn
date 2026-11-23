import type { Actor } from '@clqn/shared';
import { Hono } from 'hono';
import type { WorkspaceStore } from '../db/store.js';

export function createIdentityRoutes(store?: WorkspaceStore) {
  const app = new Hono<{ Variables: { user: Actor; tokenHash: string } }>();
  app.get('/me', (c) => c.json(c.get('user')));
  // Authentication middleware ensures the store exists and revokes only the presented credential.
  app.post('/logout', async (c) => c.json({ revoked: await store!.revokeToken(c.get('tokenHash')) }));
  return app;
}

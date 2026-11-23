import { healthSchema, VERSION } from '@clqn/shared';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { WorkspaceDb } from '../lib/access.js';

export function createHealthRoutes(db?: WorkspaceDb) {
  const app = new Hono();
  app.get('/health', (c) => c.json(healthSchema.parse({ status: 'ok', service: 'clqn-api', version: VERSION })));
  app.get('/ready', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      if (!db) throw new Error('Database is not configured');
      await db.execute(sql`select 1`);
      return c.json({ status: 'ready' });
    } catch {
      return c.json({ status: 'unavailable' }, 503);
    }
  });
  return app;
}

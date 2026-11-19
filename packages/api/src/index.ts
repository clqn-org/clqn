import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createStore } from './store.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
const hostname = process.env.HOST ?? '127.0.0.1';
const connection = process.env.DATABASE_URL ? createStore(process.env.DATABASE_URL) : undefined;
const server = serve({ fetch: createApp(connection?.store, connection?.db, { githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET, githubClientId: process.env.GITHUB_CLIENT_ID }).fetch, port, hostname }, (info) => {
  console.error(`clqn API listening on http://${hostname}:${info.port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(async (error) => {
      await connection?.close();
      process.exit(error ? 1 : 0);
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}

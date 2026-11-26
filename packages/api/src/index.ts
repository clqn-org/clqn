import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { startCloudOrchestrator } from './cloud-runner.js';
import { createStore } from './db/store.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
const hostname = process.env.HOST ?? '127.0.0.1';
const poolSize = Number(process.env.DATABASE_POOL_SIZE ?? 10);
if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 100) {
  throw new Error('DATABASE_POOL_SIZE must be an integer between 1 and 100');
}
const connection = process.env.DATABASE_URL ? createStore(process.env.DATABASE_URL, poolSize) : undefined;
const apiKey = process.env.OPENAI_API_KEY?.trim();
const maxCallsPerHour = Number(process.env.CLQN_CLOUD_CALLS_PER_HOUR || 120);
if (apiKey && (!Number.isInteger(maxCallsPerHour) || maxCallsPerHour < 1 || maxCallsPerHour > 10_000)) {
  throw new Error('CLQN_CLOUD_CALLS_PER_HOUR must be an integer between 1 and 10000');
}
if (apiKey && !connection) throw new Error('Cloud orchestration requires DATABASE_URL');
const app = createApp(connection?.store, connection?.db, {
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET || undefined,
  githubClientId: process.env.GITHUB_CLIENT_ID || undefined,
  cloudOrchestrator: Boolean(apiKey),
});
const orchestrator =
  connection && apiKey
    ? startCloudOrchestrator(connection.db, {
        apiKey,
        model: process.env.CLQN_CLOUD_MODEL?.trim() || 'gpt-5.4-mini',
        maxCallsPerHour,
      })
    : undefined;
const server = serve(
  {
    fetch: app.fetch,
    port,
    hostname,
  },
  (info) => {
    console.error(`clqn API listening on http://${hostname}:${info.port}`);
  },
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    const stopped = orchestrator?.stop();
    server.close(async (error) => {
      await stopped;
      await connection?.close();
      process.exit(error ? 1 : 0);
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}

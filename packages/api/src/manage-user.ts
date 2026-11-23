import { z } from 'zod';
import { createStore } from './db/store.js';

const [action, value, ...extra] = process.argv.slice(2);
if (extra.length || !value || !['create', 'revoke'].includes(action ?? '')) {
  throw new Error('Usage: npm run user -- create <email> | revoke <credential-id>');
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const parsed = action === 'create' ? z.email().parse(value.trim().toLowerCase()) : z.uuid().parse(value);
const connection = createStore(url);
try {
  if (action === 'create') {
    // Deliberate, one-time credential output for secure delivery by the operator.
    console.log(JSON.stringify(await connection.provisionUser(parsed)));
  } else {
    console.log(JSON.stringify({ revoked: await connection.revokeCredential(parsed) }));
  }
} finally {
  await connection.close();
}

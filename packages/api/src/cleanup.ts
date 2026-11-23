import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { cleanupDatabase } from './db/cleanup.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required to run cleanup');
const client = postgres(url, { max: 1 });
try {
  console.log(JSON.stringify(await cleanupDatabase(drizzle(client))));
} finally {
  await client.end();
}

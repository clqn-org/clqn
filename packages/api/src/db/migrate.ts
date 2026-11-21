import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required to run migrations');
const sql = postgres(url, { max: 1 });
try {
  await migrate(drizzle(sql), { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
} finally {
  await sql.end();
}

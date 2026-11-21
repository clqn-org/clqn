import { integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { clans } from './schema.js';

export const contextEntries = pgTable(
  'context_entries',
  {
    clanId: uuid('clan_id')
      .notNull()
      .references(() => clans.id),
    key: text('key').notNull(),
    text: text('text').notNull(),
    revision: integer('revision').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.clanId, table.key] })],
);

// Revisions are only inserted, never updated or deleted by the application.
export const contextRevisions = pgTable(
  'context_revisions',
  {
    clanId: uuid('clan_id')
      .notNull()
      .references(() => clans.id),
    key: text('key').notNull(),
    text: text('text').notNull(),
    revision: integer('revision').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.clanId, table.key, table.revision] })],
);

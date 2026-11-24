import type { ChatMessage, ChatSettings } from '@clqn/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents, clans, memberships, users } from './schema.js';
import { tasks } from './tasks.js';

export const chats = pgTable('chats', {
  clanId: uuid('clan_id')
    .primaryKey()
    .references(() => clans.id, { onDelete: 'cascade' }),
  hostId: uuid('host_id')
    .notNull()
    .references(() => users.id),
});

export const chatMembers = pgTable(
  'chat_members',
  {
    clanId: uuid('clan_id')
      .notNull()
      .references(() => chats.clanId, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    settings: jsonb('settings').$type<ChatSettings>().notNull(),
  },
  (table) => [
    // Membership removal also removes the member's session settings.
    foreignKey({
      columns: [table.clanId, table.userId],
      foreignColumns: [memberships.clanId, memberships.userId],
    }).onDelete('cascade'),
    primaryKey({ columns: [table.clanId, table.userId] }),
  ],
);

export type ChatProposal = { title: string; description: string; estimatedTokens: number };

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey(),
    clanId: uuid('clan_id')
      .notNull()
      .references(() => chats.clanId, { onDelete: 'cascade' }),
    sequence: bigserial('sequence', { mode: 'number' }).notNull(),
    authorId: uuid('author_id').notNull(),
    author: text('author').notNull(),
    role: text('role').$type<ChatMessage['role']>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    text: text('text').notNull(),
    status: text('status').$type<ChatMessage['status']>().notNull(),
    replyTo: uuid('reply_to'),
    workerId: uuid('worker_id').references(() => agents.id),
    proposal: jsonb('proposal').$type<ChatProposal>(),
    taskId: uuid('task_id').references(() => tasks.id),
    tokens: bigint('tokens', { mode: 'number' }),
  },
  (table) => [
    index('chat_messages_history_idx').on(table.clanId, table.sequence),
    index('chat_messages_queue_idx').on(table.clanId, table.status, table.sequence),
    index('chat_messages_worker_idx').on(table.clanId, table.workerId).where(sql`${table.workerId} is not null`),
    uniqueIndex('chat_messages_task_idx').on(table.taskId).where(sql`${table.taskId} is not null`),
  ],
);

import type { ChatMessage, ChatSettings } from '@clqn/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
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
  cloudLeaseId: uuid('cloud_lease_id'),
  cloudMessageId: uuid('cloud_message_id'),
  cloudLeaseExpiresAt: timestamp('cloud_lease_expires_at', { withTimezone: true }),
  cloudLastAttemptAt: timestamp('cloud_last_attempt_at', { withTimezone: true }),
  cloudRetryAt: timestamp('cloud_retry_at', { withTimezone: true }),
  cloudAttempts: smallint('cloud_attempts').notNull().default(0),
});

export const cloudChatQuota = pgTable('cloud_chat_quota', {
  id: smallint('id').primaryKey(),
  hour: timestamp('hour', { withTimezone: true }).notNull(),
  calls: integer('calls').notNull(),
});

export const cloudWorkerPresence = pgTable('cloud_worker_presence', {
  agentId: uuid('agent_id')
    .primaryKey()
    .references(() => agents.id, { onDelete: 'cascade' }),
  seenAt: timestamp('seen_at', { withTimezone: true }).notNull(),
});

export const chatMembers = pgTable(
  'chat_members',
  {
    clanId: uuid('clan_id').notNull(),
    userId: uuid('user_id').notNull(),
    settings: jsonb('settings').$type<ChatSettings>().notNull(),
  },
  // A member's limits, saved when they join the clan, before any session exists.
  // With a session, the row also lets them use the chat.
  (table) => [
    // Membership removal also removes the member's settings.
    foreignKey({
      columns: [table.clanId, table.userId],
      foreignColumns: [memberships.clanId, memberships.userId],
    }).onDelete('cascade'),
    primaryKey({ columns: [table.clanId, table.userId] }),
  ],
);

// Proposals saved before model limits have no model; treat them as the worker's default (null).
export type ChatProposal = { title: string; description: string; estimatedTokens: number; model?: string | null };

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
    // When the orchestrator first took the message out of the queue; null while queued and for older messages.
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    // When the orchestrator last took this message from its inbox to handle it next.
    pickedAt: timestamp('picked_at', { withTimezone: true }),
  },
  (table) => [
    index('chat_messages_history_idx').on(table.clanId, table.sequence),
    index('chat_messages_queue_idx').on(table.clanId, table.status, table.sequence),
    index('chat_messages_worker_idx').on(table.clanId, table.workerId).where(sql`${table.workerId} is not null`),
    uniqueIndex('chat_messages_task_idx').on(table.taskId).where(sql`${table.taskId} is not null`),
  ],
);

export const chatTokenHours = pgTable(
  'chat_token_hours',
  {
    clanId: uuid('clan_id')
      .notNull()
      .references(() => chats.clanId, { onDelete: 'cascade' }),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    tokens: bigint('tokens', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.clanId, table.hour] })],
);

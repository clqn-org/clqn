import type { ChatMessage, ChatSettings } from '@clqn/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
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

export const chats = pgTable(
  'chats',
  {
    clanId: uuid('clan_id')
      .primaryKey()
      .references(() => clans.id, { onDelete: 'cascade' }),
    hostId: uuid('host_id')
      .notNull()
      .references(() => users.id),
    leaseAgentId: uuid('lease_agent_id').references(() => agents.id),
    leaseId: uuid('lease_id'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'chats_host_lease_fields',
      sql`(${table.leaseAgentId} is null and ${table.leaseId} is null and ${table.leaseExpiresAt} is null)
        or (${table.leaseAgentId} is not null and ${table.leaseId} is not null)`,
    ),
  ],
);

export const chatBackups = pgTable(
  'chat_backups',
  {
    clanId: uuid('clan_id')
      .notNull()
      .references(() => chats.clanId, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.clanId, table.userId],
      foreignColumns: [memberships.clanId, memberships.userId],
    }).onDelete('cascade'),
    primaryKey({ columns: [table.clanId, table.userId] }),
  ],
);

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
    force: boolean('force').notNull().default(false),
    replyTo: uuid('reply_to'),
    workerId: uuid('worker_id').references(() => agents.id),
    proposal: jsonb('proposal').$type<ChatProposal>(),
    taskId: uuid('task_id').references(() => tasks.id),
    tokens: bigint('tokens', { mode: 'number' }),
    // When the orchestrator first took the message out of the queue; null while queued and for older messages.
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    // When the orchestrator last took this message from its inbox to handle it next.
    pickedAt: timestamp('picked_at', { withTimezone: true }),
    pickId: uuid('pick_id'),
  },
  (table) => [
    index('chat_messages_history_idx').on(table.clanId, table.sequence),
    index('chat_messages_queue_idx').on(table.clanId, table.status, table.force.desc(), table.sequence),
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

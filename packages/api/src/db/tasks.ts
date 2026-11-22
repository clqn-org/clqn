import type { TaskRepository } from '@clqn/shared';
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agents, clans, users } from './schema.js';

export const taskStatus = pgEnum('task_status', ['open', 'claimed', 'completed']);
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    alias: text('alias'),
    clanId: uuid('clan_id')
      .notNull()
      .references(() => clans.id),
    description: text('description').notNull(),
    status: taskStatus('status').notNull().default('open'),
    ownerId: uuid('owner_id').references(() => users.id),
    ownerAgentId: uuid('owner_agent_id').references(() => agents.id),
    assignedAgentId: uuid('assigned_agent_id').references(() => agents.id),
    repository: jsonb('repository').$type<TaskRepository>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tasks_clan_idx').on(table.clanId),
    uniqueIndex('tasks_clan_alias_idx').on(table.clanId, table.alias),
    // Completed tasks free their branch name for later work.
    uniqueIndex('tasks_repository_branch_idx')
      .on(table.clanId, sql`(${table.repository}->>'slug')`, sql`(${table.repository}->>'branch')`)
      .where(sql`${table.repository} IS NOT NULL AND ${table.status} <> 'completed'`),
    check(
      'task_owner_matches_status',
      sql`(${table.status} = 'open' AND ${table.ownerId} IS NULL AND ${table.ownerAgentId} IS NULL) OR (${table.status} IN ('claimed', 'completed') AND ${table.ownerId} IS NOT NULL)`,
    ),
  ],
);

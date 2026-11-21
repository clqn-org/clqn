import { z } from 'zod';
export const eventSchema = z.object({
  sequence: z.number().int().positive(),
  id: z.uuid(),
  clanId: z.uuid(),
  actorId: z.uuid(),
  agentId: z.uuid().nullable(),
  resourceId: z.string().nullable(),
  type: z.string(),
  createdAt: z.iso.datetime(),
});
export const eventsSchema = z.object({ events: z.array(eventSchema), nextCursor: z.number().int().nonnegative() });
export const statsSchema = z.object({
  members: z.number().int().nonnegative(),
  agents: z.number().int().nonnegative(),
  tasks: z.object({
    open: z.number().int().nonnegative(),
    claimed: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
  }),
});
export const statusSchema = z.object({
  clan: z.object({ id: z.uuid(), name: z.string() }),
  stats: statsSchema,
  recentActivity: z.array(eventSchema),
});

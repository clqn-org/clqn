import { z } from 'zod';
import { resourceAliasSchema } from './aliases.js';

export const actorSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  agentId: z.uuid().optional(),
  clanId: z.uuid().optional(),
});
export type Actor = z.infer<typeof actorSchema>;
export const agentRoleSchema = z.enum(['worker', 'orchestrator']);
export const agentSchema = z.object({
  alias: resourceAliasSchema.nullish(),
  id: z.uuid(),
  clanId: z.uuid(),
  ownerId: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  role: agentRoleSchema.default('worker'),
});
export type Agent = z.infer<typeof agentSchema>;
export const registerAgentSchema = z
  .object({
    alias: resourceAliasSchema.optional(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((name) => !name.includes('\0'), 'Agent names cannot contain NUL'),
    role: agentRoleSchema.default('worker'),
  })
  .strict();
export const agentRegistrationSchema = z.object({
  agent: agentSchema,
  token: z.string().regex(/^clqn_[A-Za-z0-9_-]{43}$/),
});
// `active` is false once an agent's token is revoked. Older servers omit it.
export const agentsSchema = z.object({ agents: z.array(agentSchema.extend({ active: z.boolean().optional() })) });
export const revokedAgentSchema = z.object({ agent: agentSchema, revoked: z.literal(true) });
export const logoutSchema = z.object({ revoked: z.boolean() });

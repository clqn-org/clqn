import { z } from 'zod';
import { resourceAliasSchema } from './aliases.js';
import { modelIdSchema } from './chat.js';

const modelText = z
  .string()
  .trim()
  .min(1)
  .refine((text) => !/[\x00-\x1f\x7f-\x9f]/.test(text));
export const workerModelSchema = z
  .object({
    id: modelIdSchema.refine((id) => !/^-|[\x00-\x1f\x7f-\x9f]/.test(id)),
    label: modelText.max(100).optional(),
    description: modelText.max(300).optional(),
  })
  .strict();
export type WorkerModel = z.infer<typeof workerModelSchema>;
export const workerModelsSchema = z
  .array(workerModelSchema)
  .min(1)
  .max(60)
  .refine((models) => new Set(models.map(({ id }) => id)).size === models.length, 'Model IDs must be unique');
export const workerModelReportSchema = z.object({ models: workerModelsSchema.nullable() }).strict();

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
// `active` is false once an agent's token is revoked. `allowedModels` are the owner's model limits; null allows any.
// Older servers omit `active`, `allowedModels`, and `availableModels`.
export const agentsSchema = z.object({
  agents: z.array(
    agentSchema.extend({
      active: z.boolean().optional(),
      allowedModels: z.array(z.string()).nullable().optional(),
      availableModels: workerModelsSchema.nullish(),
    }),
  ),
  nextCursor: z.uuid().optional(),
});
export const revokedAgentSchema = z.object({ agent: agentSchema, revoked: z.literal(true) });
export const logoutSchema = z.object({ revoked: z.boolean() });

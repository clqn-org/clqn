import { z } from 'zod';

// These are saved preferences for a future runner, not runtime permissions.
export const controlLevelSchema = z.enum(['manual', 'approve', 'automatic']);
export const tokenLimitSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
export const allowedModelsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((model) => !/\s|\0/.test(model), 'Model identifiers cannot contain whitespace or NUL'),
  )
  .min(1)
  .max(100)
  .refine((models) => new Set(models).size === models.length, 'Model identifiers must be unique')
  .nullable();
export const policySettingsSchema = z
  .object({
    tokenLimit: tokenLimitSchema,
    allowedModels: allowedModelsSchema,
    control: controlLevelSchema,
  })
  .strict();
export type PolicySettings = z.infer<typeof policySettingsSchema>;
export const defaultPolicy: PolicySettings = { tokenLimit: null, allowedModels: null, control: 'manual' };
export const memberPolicySchema = policySettingsSchema.extend({
  clanId: z.uuid(),
  userId: z.uuid(),
  revision: z.number().int().nonnegative(),
  enforcement: z.literal('unavailable'),
});
export const updatePolicySchema = policySettingsSchema
  .partial()
  .extend({
    expectedRevision: z.number().int().nonnegative().max(2_147_483_646),
  })
  .strict()
  .refine(
    (value) => value.tokenLimit !== undefined || value.allowedModels !== undefined || value.control !== undefined,
    'Provide at least one policy setting',
  );
export type UpdatePolicy = z.infer<typeof updatePolicySchema>;

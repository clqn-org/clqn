import { z } from 'zod';
import { repositorySlugSchema } from './tasks.js';

export const linkRepositorySchema = z.object({ slug: repositorySlugSchema }).strict();
export const linkedRepositorySchema = z.object({
  id: z.uuid(),
  clanId: z.uuid(),
  slug: repositorySlugSchema,
  createdAt: z.iso.datetime(),
  lastEventSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type LinkedRepository = z.infer<typeof linkedRepositorySchema>;
export const linkedRepositoriesSchema = z.object({ repositories: z.array(linkedRepositorySchema) });
export const linkedRepositorySetupSchema = z.object({
  repository: linkedRepositorySchema,
  webhook: z.object({
    path: z
      .string()
      .regex(/^\/hooks\/github\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    secret: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});
export const unlinkedRepositorySchema = z.object({ unlinked: z.literal(true) });

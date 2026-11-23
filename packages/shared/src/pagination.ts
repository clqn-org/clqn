import { z } from 'zod';

export const pageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(100),
    after: z.uuid().optional(),
  })
  .strict();
export type PageQuery = z.infer<typeof pageQuerySchema>;

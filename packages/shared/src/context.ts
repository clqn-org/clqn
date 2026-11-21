import { z } from 'zod';

export const contextKeySchema = z
  .string()
  .min(1)
  .max(200)
  .refine((key) => key !== '.' && key !== '..' && !key.includes('\0'), 'Context keys cannot be dot-only path segments');
export const writeContextSchema = z
  .object({
    text: z
      .string()
      .refine((text) => !text.includes('\0'), 'Context text cannot contain NUL')
      .refine(
        (text) => new TextEncoder().encode(text).byteLength <= 65_536,
        'Context text must be at most 65536 UTF-8 bytes',
      ),
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
  })
  .strict();
export const contextEntrySchema = z.object({
  key: contextKeySchema,
  text: z.string(),
  revision: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
});
export const contextListSchema = z.object({ entries: z.array(contextEntrySchema.omit({ text: true })) });
export const contextHistorySchema = z.object({ revisions: z.array(contextEntrySchema) });
export type ContextEntry = z.infer<typeof contextEntrySchema>;
export type WriteContext = z.infer<typeof writeContextSchema>;

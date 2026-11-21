import { z } from 'zod';

export const resourceAliasSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'Use lowercase letters, digits, and single hyphens, starting with a letter')
  .refine((alias) => !z.guid().safeParse(alias).success, 'An alias cannot be a UUID');
export const resourceReferenceSchema = z
  .union([z.uuid(), resourceAliasSchema])
  .describe('UUID or custom alias in this clan');
export const setAliasSchema = z.object({ alias: resourceAliasSchema }).strict();

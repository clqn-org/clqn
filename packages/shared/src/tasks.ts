import { z } from 'zod';
import { resourceAliasSchema, resourceReferenceSchema } from './aliases.js';

export const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, 'Use a full lowercase Git commit SHA');
export const repositorySlugSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use a GitHub owner/repository name')
  .refine(
    (slug) => !slug.toLowerCase().endsWith('.git') && !slug.includes('..'),
    'Use the repository name without a .git suffix',
  )
  .transform((slug) => slug.toLowerCase());
// Deliberately narrower than all valid Git refs; never allow option-like values or ref expressions.
export const gitBranchSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine(
    (branch) =>
      branch !== 'HEAD' &&
      !branch.startsWith('refs/') &&
      !branch.includes('..') &&
      !branch.includes('//') &&
      !branch.endsWith('.') &&
      branch.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock')),
    'Use a branch name, not a Git revision expression',
  );
export const repositoryInputSchema = z
  .object({
    slug: repositorySlugSchema,
    baseBranch: gitBranchSchema.default('main'),
    baseSha: gitShaSchema,
    branch: gitBranchSchema,
  })
  .strict()
  .refine((repository) => repository.branch !== repository.baseBranch, 'Task branch must differ from the base branch');
export type RepositoryInput = z.input<typeof repositoryInputSchema>;
export const taskRepositorySchema = repositoryInputSchema.safeExtend({
  headSha: gitShaSchema.nullable(),
  prNumber: z.number().int().positive().nullable(),
  prUrl: z.url().nullable(),
  mergeCommitSha: gitShaSchema.nullable(),
  state: z.enum(['pending', 'pushed', 'open', 'merged']),
});
export type TaskRepository = z.infer<typeof taskRepositorySchema>;
export const repositoryReportSchema = z
  .object({
    expectedHeadSha: gitShaSchema.nullable(),
    headSha: gitShaSchema,
    prNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    prUrl: z.string().url().max(500).optional(),
  })
  .strict()
  .refine(
    (report) => (report.prNumber === undefined) === (report.prUrl === undefined),
    'Provide both prNumber and prUrl',
  );
export type RepositoryReport = z.infer<typeof repositoryReportSchema>;
export const integrationReportSchema = z.object({ headSha: gitShaSchema, mergeCommitSha: gitShaSchema }).strict();
export type IntegrationReport = z.infer<typeof integrationReportSchema>;
export const assignTaskSchema = z.object({ agentId: resourceReferenceSchema }).strict();
export const createTaskSchema = z
  .object({
    alias: resourceAliasSchema.optional(),
    description: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .refine((text) => !text.includes('\0'), 'Task descriptions cannot contain NUL'),
    repository: repositoryInputSchema.optional(),
  })
  .strict();
export const taskSchema = z.object({
  alias: resourceAliasSchema.nullish(),
  id: z.uuid(),
  clanId: z.uuid(),
  description: z.string(),
  status: z.enum(['open', 'claimed', 'completed']),
  ownerId: z.uuid().nullable(),
  ownerAgentId: z.uuid().nullable(),
  assignedAgentId: z.uuid().nullable().default(null),
  repository: taskRepositorySchema.nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const tasksSchema = z.object({ tasks: z.array(taskSchema) });
export type Task = z.infer<typeof taskSchema>;

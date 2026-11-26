import { z } from 'zod';
import { taskRepositorySchema } from './tasks.js';

export const limitSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
export const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((model) => !/\s|\0/.test(model), 'Model identifiers cannot contain whitespace or NUL');
export const allowedModelsSchema = z
  .array(modelIdSchema)
  .min(1)
  .max(100)
  .refine((models) => new Set(models).size === models.length, 'Model identifiers must be unique')
  .nullable();
export const workerCommandsSchema = z.enum(['off', 'sandboxed', 'unrestricted']);
export type WorkerCommands = z.infer<typeof workerCommandsSchema>;
// A member's own limits for agents on their machine, enforced before each delegation. Null means no limit.
export const chatSettingsSchema = z
  .object({
    approval: z.enum(['manual', 'automatic']),
    tokenLimit: limitSchema,
    agentLimit: limitSchema,
    // Older servers and clients omit it.
    allowedModels: allowedModelsSchema.default(null),
    // What workers on this machine may run: nothing, commands inside the agent's sandbox, or anything.
    commands: workerCommandsSchema.default('sandboxed'),
  })
  .strict();
export type ChatSettings = z.infer<typeof chatSettingsSchema>;
// Full access: no token, agent, or model limits. Each delegation still needs the member's approval.
export const defaultChatSettings: ChatSettings = {
  approval: 'manual',
  tokenLimit: null,
  agentLimit: null,
  allowedModels: null,
  commands: 'sandboxed',
};

const chatText = z
  .string()
  .trim()
  .min(1)
  .max(4000)
  .refine((text) => !text.includes('\0'));
const tokenCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// Images and PDFs a member attaches to a message, sent with it as base64.
export const chatAttachmentTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'] as const;
export const chatAttachmentLimit = { files: 4, bytes: 5 * 1024 * 1024 };
const attachmentName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((name) => !/[\x00-\x1f\x7f]/.test(name));
export const chatAttachmentInputSchema = z
  .object({
    name: attachmentName,
    type: z.enum(chatAttachmentTypes),
    data: z
      .base64()
      .max(Math.ceil(chatAttachmentLimit.bytes / 3) * 4)
      .min(1),
  })
  .strict();
export type ChatAttachmentInput = z.infer<typeof chatAttachmentInputSchema>;
export const chatAttachmentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.enum(chatAttachmentTypes),
  size: z.number().int().nonnegative(),
});
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>;
export const chatAttachmentFileSchema = chatAttachmentSchema.extend({ data: z.base64() });
export const sendChatSchema = z
  .object({
    id: z.uuid(),
    text: chatText,
    replyTo: z.uuid().optional(),
    force: z.boolean().optional(),
    attachments: z.array(chatAttachmentInputSchema).min(1).max(chatAttachmentLimit.files).optional(),
  })
  .strict();
export type SendChat = z.infer<typeof sendChatSchema>;
export const chatDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reply'), text: chatText }).strict(),
  z.object({ action: z.literal('clarify'), text: chatText, hold: z.uuid().optional() }).strict(),
  z
    .object({
      action: z.literal('delegate'),
      title: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .refine((text) => !text.includes('\0')),
      description: chatText,
      workerId: z.uuid(),
      estimatedTokens: tokenCount.min(1),
      // Must be one of the worker owner's allowed models. Defaults to their first allowed model, or none if any is allowed.
      model: modelIdSchema.optional(),
    })
    .strict(),
]);
export type ChatDecision = z.infer<typeof chatDecisionSchema>;
const [replyDecision, clarifyDecision, delegateDecision] = chatDecisionSchema.options;
const pick = { pickId: z.uuid().optional() };
export const chatDecisionRequestSchema = z.discriminatedUnion('action', [
  replyDecision.extend(pick),
  clarifyDecision.extend(pick),
  delegateDecision.extend(pick),
]);
export type ChatDecisionRequest = z.infer<typeof chatDecisionRequestSchema>;
export const chatApprovalSchema = z.object({ approve: z.boolean() }).strict();
export const chatUsageSchema = z
  .object({ tokens: tokenCount, result: z.object({ id: z.uuid(), text: chatText }).strict().optional() })
  .strict();
export type ChatUsage = z.infer<typeof chatUsageSchema>;
export const chatMessageStatusSchema = z.enum(['queued', 'handled', 'clarification', 'approval', 'declined']);
export const chatMessageSchema = z.object({
  id: z.uuid(),
  sequence: z.number().int().positive(),
  authorId: z.uuid(),
  author: z.string(),
  role: z.enum(['member', 'orchestrator', 'worker']),
  createdAt: z.iso.datetime(),
  text: z.string(),
  status: chatMessageStatusSchema,
  replyTo: z.uuid().nullable(),
  // True while the orchestrator is handling this queued message. Older servers omit it.
  processing: z.boolean().optional(),
  force: z.boolean().optional(),
  attachments: z.array(chatAttachmentSchema).optional(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export const chatProposalSchema = z.object({
  messageId: z.uuid(),
  title: z.string(),
  worker: z.string(),
  estimatedTokens: tokenCount,
  // Null means the worker's default model. Older servers omit it.
  model: z.string().nullable().optional(),
});
export const chatRunSchema = chatProposalSchema.extend({
  taskId: z.uuid(),
  // The assigned worker agent, so its owner's clqn can start it. Older servers omit it.
  workerId: z.uuid().optional(),
  status: z.enum(['queued', 'running', 'done', 'released']),
  tokens: tokenCount.nullable(),
  repository: taskRepositorySchema.nullish(),
  // Files from the delegated message and the message it answered, for the worker. Older servers omit it.
  attachments: z.array(chatAttachmentSchema).optional(),
});
export type ChatRun = z.infer<typeof chatRunSchema>;
export const chatMergeRequestSchema = z.object({
  taskId: z.uuid(),
  title: z.string(),
  repository: taskRepositorySchema,
});
export type ChatMergeRequest = z.infer<typeof chatMergeRequestSchema>;
export const chatBackupsSchema = z.object({ userIds: z.array(z.uuid()) });
export const chatBackupsInputSchema = chatBackupsSchema.strict();
export const chatLeaseInputSchema = z.object({ leaseId: z.uuid() }).strict();
export const chatLeaseHeartbeatSchema = chatLeaseInputSchema.extend({ renew: z.boolean().optional() });
export const chatLeaseSchema = z.object({ active: z.boolean() });
export const chatOrchestrationSchema = z.object({
  backup: z.boolean(),
  eligible: z.boolean(),
  activeHost: z.string().nullable(),
});
export const chatSessionSchema = z.object({ host: z.string(), clan: z.string() });
export const chatInfoSchema = z.object({
  session: chatSessionSchema.nullable(),
  clan: z.string(),
  canStart: z.boolean(),
  settings: chatSettingsSchema,
});
export const chatHistorySchema = z.object({
  messages: z.array(chatMessageSchema),
  before: z.number().int().positive().nullable(),
});
export const chatStateSchema = chatHistorySchema.extend({
  session: chatSessionSchema,
  settings: chatSettingsSchema,
  approvals: z.array(chatProposalSchema),
  questions: z.array(chatMessageSchema),
  runs: z.array(chatRunSchema),
  mergeQueue: z.array(chatMergeRequestSchema).optional(),
  orchestration: chatOrchestrationSchema.optional(),
  queued: z.number().int().nonnegative(),
  forcePending: z.object({ id: z.uuid(), processing: z.boolean() }).nullable().optional(),
  running: z.number().int().nonnegative(),
  usage: z.object({ tokens: tokenCount, reserved: tokenCount, agents: z.number().int().nonnegative() }),
});
export type ChatState = z.infer<typeof chatStateSchema>;
// Recent chat plus the one queued message to handle now (null when the queue is empty).
export const chatInboxSchema = chatHistorySchema.extend({
  next: chatMessageSchema.nullable(),
  pickId: z.uuid().nullish(),
  held: z.array(chatMessageSchema),
});

// 24h uses hourly buckets; 7d uses 6-hour buckets. The last bucket holds the current hour.
export const chatMetricsWindows = {
  '24h': { buckets: 24, bucketHours: 1 },
  '7d': { buckets: 28, bucketHours: 6 },
} as const;
export const chatMetricsWindowSchema = z.enum(['24h', '7d']);
export type ChatMetricsWindow = z.infer<typeof chatMetricsWindowSchema>;
const seconds = z.number().nonnegative();
export const chatMetricsSchema = z.object({
  window: chatMetricsWindowSchema,
  bucketHours: z.number().int().positive(),
  start: z.iso.datetime({ offset: true }),
  // Per bucket: reported tokens, agents running at any point, and average queue wait of messages sent then.
  tokens: z.array(tokenCount),
  agents: z.array(z.number().int().nonnegative()),
  queueWait: z.array(seconds.nullable()),
  queue: z.object({
    averageSeconds: seconds.nullable(),
    longestSeconds: seconds.nullable(),
    waiting: z.number().int().nonnegative(),
    oldestSeconds: seconds.nullable(),
  }),
  // Lifetime usage, the same total each member's token limit is enforced against.
  members: z.array(
    z.object({ name: z.string(), tokens: tokenCount, reserved: tokenCount, tokenLimit: tokenCount.nullable() }),
  ),
  // Delegations sent in the window, plus any still active.
  tasks: z.array(chatRunSchema.omit({ messageId: true, taskId: true, model: true, repository: true })),
});
export type ChatMetrics = z.infer<typeof chatMetricsSchema>;

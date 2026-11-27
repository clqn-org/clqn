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
export const defaultPlannerLimit = 5;
export const chatPlannerLimitSchema = z.number().int().min(1).max(2_147_483_647).nullable();
export const chatPlannerLimitInputSchema = z.object({ plannerLimit: chatPlannerLimitSchema }).strict();
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
const workTitle = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((text) => !text.includes('\0'));
export const sendChatSchema = z
  .object({ id: z.uuid(), text: chatText, replyTo: z.uuid().optional(), force: z.boolean().optional() })
  .strict();
export type SendChat = z.infer<typeof sendChatSchema>;
export const chatDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reply'), text: chatText }).strict(),
  z.object({ action: z.literal('clarify'), text: chatText, hold: z.uuid().optional() }).strict(),
  z
    .object({
      action: z.literal('delegate'),
      title: workTitle,
      description: chatText,
      workerId: z.uuid(),
      estimatedTokens: tokenCount.min(1),
      // Must be one of the worker owner's allowed models. Defaults to their first allowed model, or none if any is allowed.
      model: modelIdSchema.optional(),
      // Continue an earlier delegation's task on its branch: retry a stopped run or follow up on its pull request.
      // The task's previous worker must run it, since its worktree is on that worker's machine.
      taskId: z.uuid().optional(),
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
const startWork = z
  .object({
    action: z.literal('start'),
    work: z
      .array(z.object({ title: workTitle, description: chatText }).strict())
      .min(1)
      .max(8),
  })
  .strict();
const followUp = z.object({ action: z.literal('followup'), workId: z.uuid() }).strict();
const routeClarification = clarifyDecision.omit({ hold: true });
export const chatRouteDecisionSchema = z.discriminatedUnion('action', [
  replyDecision,
  routeClarification,
  startWork,
  followUp,
]);
export type ChatRouteDecision = z.infer<typeof chatRouteDecisionSchema>;
const routePick = { pickId: z.uuid() };
export const chatRouteRequestSchema = z.discriminatedUnion('action', [
  replyDecision.extend(routePick),
  routeClarification.extend(routePick),
  startWork.extend(routePick),
  followUp.extend(routePick),
]);
export type ChatRouteRequest = z.infer<typeof chatRouteRequestSchema>;
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
  plannerLimit: chatPlannerLimitSchema.optional(),
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
const chatWorkSchema = z.object({
  id: z.uuid(),
  title: workTitle,
  status: z.enum([...chatMessageStatusSchema.options, 'running', 'done', 'released', 'review']),
  requestId: z.uuid().optional(),
  position: z.number().int().positive().optional(),
});
export const chatStateSchema = chatHistorySchema.extend({
  session: chatSessionSchema,
  settings: chatSettingsSchema,
  approvals: z.array(chatProposalSchema),
  questions: z.array(chatMessageSchema),
  runs: z.array(chatRunSchema),
  mergeQueue: z.array(chatMergeRequestSchema).optional(),
  orchestration: chatOrchestrationSchema.optional(),
  workerModelDiscovery: z.boolean().optional(),
  queued: z.number().int().nonnegative(),
  forcePending: z.object({ id: z.uuid(), processing: z.boolean() }).nullable().optional(),
  work: z.object({ pending: z.uuid().nullable(), ready: z.array(z.uuid()) }).optional(),
  running: z.number().int().nonnegative(),
  usage: z.object({ tokens: tokenCount, reserved: tokenCount, agents: z.number().int().nonnegative() }),
});
export type ChatState = z.infer<typeof chatStateSchema>;
// Recent chat plus the one queued message to handle now (null when the queue is empty).
export const chatInboxSchema = chatHistorySchema.extend({
  next: chatMessageSchema.nullable(),
  pickId: z.uuid().nullish(),
  held: z.array(chatMessageSchema),
  // Recent delegations for hosts that route and decide in a single turn.
  runs: z.array(chatRunSchema).optional(),
  work: z.array(chatWorkSchema).optional(),
  workItem: chatWorkSchema.extend({ taskId: z.uuid().optional(), workerId: z.uuid().optional() }).optional(),
});
export const chatFollowupsSchema = z.object({
  messages: z.array(z.object({ sequence: z.number().int().positive(), id: z.uuid(), text: chatText })),
  next: z.number().int().nonnegative(),
});
export type ChatFollowups = z.infer<typeof chatFollowupsSchema>;

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

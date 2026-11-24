import { z } from 'zod';
import { tokenLimitSchema } from './policy.js';

export const chatSettingsSchema = z
  .object({
    approval: z.enum(['manual', 'automatic']),
    tokenLimit: tokenLimitSchema,
    agentLimit: tokenLimitSchema,
  })
  .strict();
export type ChatSettings = z.infer<typeof chatSettingsSchema>;
export const defaultChatSettings: ChatSettings = { approval: 'manual', tokenLimit: 50_000, agentLimit: 3 };

const chatText = z
  .string()
  .trim()
  .min(1)
  .max(4000)
  .refine((text) => !text.includes('\0'));
const tokenCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const chatTokenHistoryHours = 24;
export const sendChatSchema = z.object({ id: z.uuid(), text: chatText, replyTo: z.uuid().optional() }).strict();
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
    })
    .strict(),
]);
export type ChatDecision = z.infer<typeof chatDecisionSchema>;
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
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export const chatProposalSchema = z.object({
  messageId: z.uuid(),
  title: z.string(),
  worker: z.string(),
  estimatedTokens: tokenCount,
});
export const chatRunSchema = chatProposalSchema.extend({
  taskId: z.uuid(),
  status: z.enum(['queued', 'running', 'done', 'released']),
  tokens: tokenCount.nullable(),
});
export type ChatRun = z.infer<typeof chatRunSchema>;
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
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  usage: z.object({ tokens: tokenCount, reserved: tokenCount, agents: z.number().int().nonnegative() }),
  // Older servers have totals but no timestamped reports.
  reportedTokensByHour: z.array(tokenCount).length(chatTokenHistoryHours).optional(),
});
export type ChatState = z.infer<typeof chatStateSchema>;
export const chatInboxSchema = chatHistorySchema.extend({
  queued: z.array(chatMessageSchema),
  held: z.array(chatMessageSchema),
});

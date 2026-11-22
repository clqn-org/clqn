import {
  linkedRepositoriesSchema,
  linkedRepositorySchema,
  linkedRepositorySetupSchema,
  linkRepositorySchema,
  unlinkedRepositorySchema,
} from './repositories.js';

export * from './repositories.js';

import { memberPolicySchema, type UpdatePolicy, updatePolicySchema } from './policy.js';

export * from './policy.js';

import { z } from 'zod';
import { eventsSchema, statsSchema, statusSchema } from './activity.js';
import {
  actorSchema,
  agentRegistrationSchema,
  agentSchema,
  agentsSchema,
  logoutSchema,
  registerAgentSchema,
  revokedAgentSchema,
} from './agents.js';
import { setAliasSchema } from './aliases.js';
import {
  contextEntrySchema,
  contextHistorySchema,
  contextKeySchema,
  contextListSchema,
  writeContextSchema,
} from './context.js';
import {
  assignTaskSchema,
  createTaskSchema,
  type IntegrationReport,
  integrationReportSchema,
  type RepositoryInput,
  type RepositoryReport,
  repositoryReportSchema,
  taskSchema,
  tasksSchema,
} from './tasks.js';

export * from './activity.js';
export * from './agents.js';
export * from './aliases.js';
export * from './context.js';
export * from './tasks.js';

export const githubStartSchema = z.object({
  handle: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  userCode: z.string(),
  verificationUri: z.literal('https://github.com/login/device'),
  expiresIn: z.number().int().positive().max(900),
  interval: z.number().int().min(5).max(300),
});
export const githubPollSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), interval: z.number().int().min(5).max(300) }),
  z.object({
    status: z.literal('complete'),
    token: z.string().regex(/^clqn_[A-Za-z0-9_-]{43}$/),
    user: z.object({ id: z.uuid(), email: z.email() }),
  }),
  z.object({ status: z.enum(['expired', 'denied', 'account_conflict']) }),
]);
export const VERSION = '0.1.0';
export const healthSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('clqn-api'),
  version: z.string(),
});
export type Health = z.infer<typeof healthSchema>;
export const userSchema = z.object({ id: z.uuid(), email: z.email() });
export type User = z.infer<typeof userSchema>;
export const createClanSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((name) => !name.includes('\0'), 'Clan names cannot contain NUL'),
  })
  .strict();
export const clanSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
});
export type Clan = z.infer<typeof clanSchema>;
export const createInvitationSchema = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()) }).strict();
export const invitationCodeSchema = z.string().regex(/^clqn_inv_[A-Za-z0-9_-]{43}$/);
export const joinInvitationSchema = z.object({ code: invitationCodeSchema }).strict();
export const invitationSchema = z.object({
  code: invitationCodeSchema,
  clanId: z.uuid(),
  email: z.email(),
  expiresAt: z.iso.datetime(),
});
export type Invitation = z.infer<typeof invitationSchema>;
export const clansSchema = z.object({ clans: z.array(clanSchema) });
export const membersSchema = z.object({
  members: z.array(
    z.object({
      userId: z.uuid(),
      email: z.email(),
      role: z.enum(['leader', 'member']),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export type ApiErrorBody = z.infer<typeof errorSchema>;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Both adapters use this client; collaboration rules belong on the API server.
export class ClqnClient {
  private readonly baseUrl: URL;
  constructor(
    baseUrl: string,
    private readonly token?: string,
  ) {
    this.baseUrl = new URL(baseUrl);
    if (!['http:', 'https:'].includes(this.baseUrl.protocol)) {
      throw new Error('CLQN_API_URL must use HTTP or HTTPS');
    }
    if (this.baseUrl.username || this.baseUrl.password) throw new Error('API URL must not contain credentials');
    if (
      token &&
      this.baseUrl.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(this.baseUrl.hostname)
    ) {
      throw new Error('Authenticated requests require HTTPS except on loopback');
    }
  }
  private async request<T>(path: string, schema: z.ZodType<T>, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: body === undefined ? 'GET' : 'POST',
      signal: signal ? AbortSignal.any([AbortSignal.timeout(10_000), signal]) : AbortSignal.timeout(10_000),
      redirect: 'error',
      headers: {
        accept: 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const parsed = errorSchema.safeParse(await response.json().catch(() => null));
      throw new ApiError(
        response.status,
        parsed.success ? parsed.data.error.code : 'HTTP_ERROR',
        parsed.success ? parsed.data.error.message : `API returned HTTP ${response.status}`,
      );
    }
    return schema.parse(await response.json());
  }
  private requireSecureLogin() {
    if (this.baseUrl.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(this.baseUrl.hostname)) {
      throw new Error('GitHub login requires HTTPS except on loopback');
    }
  }
  startGithubLogin() {
    this.requireSecureLogin();
    return this.request('/auth/github/start', githubStartSchema, {});
  }
  pollGithubLogin(handle: string) {
    this.requireSecureLogin();
    return this.request('/auth/github/poll', githubPollSchema, { handle });
  }
  health(): Promise<Health> {
    return this.request('/health', healthSchema);
  }
  whoami(signal?: AbortSignal) {
    return this.request('/v1/me', actorSchema, undefined, signal);
  }
  logout() {
    return this.request('/v1/logout', logoutSchema, {});
  }
  createClan(name: string): Promise<Clan> {
    return this.request('/v1/clans', clanSchema, createClanSchema.parse({ name }));
  }
  listClans() {
    return this.request('/v1/clans', clansSchema);
  }
  members(clanId: string) {
    return this.request(`/v1/clans/${encodeURIComponent(clanId)}/members`, membersSchema);
  }
  createInvitation(clanId: string, email: string): Promise<Invitation> {
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/invitations`,
      invitationSchema,
      createInvitationSchema.parse({ email }),
    );
  }
  joinClan(code: string): Promise<Clan> {
    return this.request('/v1/invitations/join', clanSchema, joinInvitationSchema.parse({ code }));
  }
  registerAgent(clanId: string, name: string, role: 'worker' | 'orchestrator' = 'worker', alias?: string) {
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/agents`,
      agentRegistrationSchema,
      registerAgentSchema.parse({ name, role, alias }),
    );
  }
  setAgentAlias(clanId: string, agentId: string, alias: string) {
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/agents/${encodeURIComponent(agentId)}/alias`,
      agentSchema,
      setAliasSchema.parse({ alias }),
    );
  }
  revokeAgent(clanId: string, agentId: string) {
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/agents/${encodeURIComponent(agentId)}/revoke`,
      revokedAgentSchema,
      {},
    );
  }
  rotateAgentToken(clanId: string, agentId: string) {
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/agents/${encodeURIComponent(agentId)}/token`,
      agentRegistrationSchema,
      {},
    );
  }
  listAgents(clanId: string) {
    return this.request(`/v1/clans/${encodeURIComponent(clanId)}/agents`, agentsSchema);
  }
  agentStatus() {
    return this.request('/v1/agent', agentSchema);
  }
  policy(clanId: string) {
    return this.request(`/v1/clans/${encodeURIComponent(clanId)}/policy`, memberPolicySchema);
  }
  updatePolicy(clanId: string, policy: UpdatePolicy) {
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/policy`,
      memberPolicySchema,
      updatePolicySchema.parse(policy),
    );
  }
  linkRepository(clanId: string, slug: string) {
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/repositories`,
      linkedRepositorySetupSchema,
      linkRepositorySchema.parse({ slug }),
    );
  }
  repositories(clanId: string, signal?: AbortSignal) {
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/repositories`,
      linkedRepositoriesSchema,
      undefined,
      signal,
    );
  }
  repository(clanId: string, repositoryId: string, signal?: AbortSignal) {
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/repositories/${encodeURIComponent(repositoryId)}`,
      linkedRepositorySchema,
      undefined,
      signal,
    );
  }
  unlinkRepository(clanId: string, repositoryId: string) {
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/repositories/${encodeURIComponent(repositoryId)}/unlink`,
      unlinkedRepositorySchema,
      {},
    );
  }
  listContext(clanId: string) {
    return this.request(`/v1/clans/${encodeURIComponent(clanId)}/context`, contextListSchema);
  }
  readContext(clanId: string, key: string) {
    contextKeySchema.parse(key);
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/context/${encodeURIComponent(key)}`,
      contextEntrySchema,
    );
  }
  writeContext(clanId: string, key: string, text: string, expectedRevision: number) {
    contextKeySchema.parse(key);
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/context/${encodeURIComponent(key)}`,
      contextEntrySchema,
      writeContextSchema.parse({ text, expectedRevision }),
    );
  }
  contextHistory(clanId: string, key: string) {
    contextKeySchema.parse(key);
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/context/${encodeURIComponent(key)}/history`,
      contextHistorySchema,
    );
  }
  createTask(clanId: string, description: string, repository?: RepositoryInput, alias?: string) {
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/tasks`,
      taskSchema,
      createTaskSchema.parse({ description, repository, alias }),
    );
  }
  setTaskAlias(clanId: string, taskId: string, alias: string) {
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/tasks/${encodeURIComponent(taskId)}/alias`,
      taskSchema,
      setAliasSchema.parse({ alias }),
    );
  }
  task(clanId: string, taskId: string) {
    return this.request(`/v1/clans/${encodeURIComponent(clanId)}/tasks/${encodeURIComponent(taskId)}`, taskSchema);
  }
  assignTask(clanId: string, taskId: string, agentId: string) {
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/tasks/${encodeURIComponent(taskId)}/assign`,
      taskSchema,
      assignTaskSchema.parse({ agentId }),
    );
  }
  unassignTask(clanId: string, taskId: string, agentId: string) {
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/tasks/${encodeURIComponent(taskId)}/unassign`,
      taskSchema,
      assignTaskSchema.parse({ agentId }),
    );
  }
  reportTaskRepository(clanId: string, taskId: string, report: RepositoryReport) {
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/tasks/${encodeURIComponent(taskId)}/repository`,
      taskSchema,
      repositoryReportSchema.parse(report),
    );
  }
  integrateTask(clanId: string, taskId: string, report: IntegrationReport) {
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/tasks/${encodeURIComponent(taskId)}/integration`,
      taskSchema,
      integrationReportSchema.parse(report),
    );
  }
  listTasks(clanId: string) {
    return this.request(`/v1/clans/${encodeURIComponent(clanId)}/tasks`, tasksSchema);
  }
  transitionTask(clanId: string, taskId: string, action: 'claim' | 'release' | 'complete') {
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/tasks/${encodeURIComponent(taskId)}/${action}`,
      taskSchema,
      {},
    );
  }

  events(clanId: string, cursor = 0, limit = 100, signal?: AbortSignal) {
    return this.request(
      `/v1/clans/${encodeURIComponent(clanId)}/events?cursor=${cursor}&limit=${limit}`,
      eventsSchema,
      undefined,
      signal,
    );
  }
  stats(clanId: string) {
    return this.request(`/v1/clans/${encodeURIComponent(clanId)}/stats`, statsSchema);
  }
  status(clanId: string) {
    return this.request(`/v1/clans/${encodeURIComponent(clanId)}/status`, statusSchema);
  }
}

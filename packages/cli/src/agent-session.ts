import { createHash } from 'node:crypto';
import { constants, mkdirSync } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { agentRegistrationSchema, agentSchema, ClqnClient, type WorkerCommands } from '@clqn/shared';
import { configDirectory, writePrivateJson } from './config.js';

export const runtimes = ['codex', 'claude'] as const;
export type Runtime = (typeof runtimes)[number];

export const runtimeNames: Record<Runtime, string> = { claude: 'Claude Code', codex: 'Codex' };

// On Windows, spawning `claude` without a shell also runs claude.com or claude.exe, and the native Claude Code
// installer adds only claude.exe to PATH.
const programNames = (runtime: Runtime, platform: NodeJS.Platform) =>
  platform === 'win32' ? [runtime, `${runtime}.com`, `${runtime}.exe`] : [runtime];

async function installed(runtime: Runtime, path: string, platform: NodeJS.Platform) {
  const directories = path.split(delimiter).filter(Boolean);
  return Promise.any(
    directories.flatMap((directory) =>
      programNames(runtime, platform).map(async (name) => {
        const file = resolve(directory, name);
        await access(file, constants.X_OK);
        if (!(await stat(file)).isFile()) throw new Error();
      }),
    ),
  ).then(
    () => true,
    () => false,
  );
}

// The agent CLIs on PATH, in the order the orchestrator prefers them.
export async function installedRuntimes(
  path = process.env.PATH ?? '',
  platform = process.platform,
): Promise<Runtime[]> {
  const found = await Promise.all(runtimes.map((runtime) => installed(runtime, path, platform)));
  return runtimes.filter((_, index) => found[index]);
}

// Agents the member turned off on this machine. Saving what is off keeps newly installed agents on.
const choicesPath = () => join(configDirectory(), 'agents.json');

export async function readAgentsOff(): Promise<Runtime[]> {
  try {
    const value: unknown = JSON.parse(await readFile(choicesPath(), 'utf8'));
    const off = (value as { off?: unknown } | null)?.off;
    return runtimes.filter((runtime) => Array.isArray(off) && off.includes(runtime));
  } catch {
    return [];
  }
}

export function saveAgentsOff(off: Runtime[]): Promise<void> {
  return writePrivateJson(choicesPath(), { off: runtimes.filter((runtime) => off.includes(runtime)) });
}

export type AgentProfile = {
  agentId: string;
  clanId: string;
  server: string;
  token: string;
  runtime?: Runtime | undefined;
};

export function agentProfilePath(server: string, agentId: string): string {
  const origin = new URL(server).origin;
  const hash = createHash('sha256').update(origin).digest('hex');
  return resolve(configDirectory(), 'agents', `${hash}-${agentId}.json`);
}

export async function readAgentProfile(path: string): Promise<AgentProfile | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    const profile = {
      agentId: agentSchema.shape.id.parse(value.agentId),
      clanId: agentSchema.shape.clanId.parse(value.clanId),
      server: new URL(value.server).origin,
      token: agentRegistrationSchema.shape.token.parse(value.token),
      runtime: runtimes.find((runtime) => runtime === value.runtime),
    };
    new ClqnClient(profile.server, profile.token);
    return profile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Could not read the saved agent connection.');
  }
}

export async function saveAgentProfile(profile: AgentProfile): Promise<void> {
  await writePrivateJson(agentProfilePath(profile.server, profile.agentId), profile);
}

export interface AgentCommand {
  command: Runtime;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const workerSandbox = {
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: ['registry.npmjs.org'] },
  },
};

// A non-interactive runtime run with the agent's clqn MCP server. The prompt goes to stdin, so chat text never
// appears in argv. The orchestrator may only use clqn tools; workers may also edit files in their workspace and run
// commands as the member's setting allows. Codex cannot edit without running commands, so `off` makes it read-only.
export function agentCommand(
  runtime: Runtime,
  profilePath: string,
  options: {
    project: string;
    role: 'orchestrator' | 'worker';
    model?: string | null | undefined;
    commands?: WorkerCommands | undefined;
    // Claude Code only: keep running and read one JSON user message per line from stdin, each a turn.
    session?: boolean | undefined;
    // Rules added to the system (Claude Code) or developer (Codex) instructions, so they hold for every turn.
    instructions?: string | undefined;
    // Codex only: continue this earlier session, so the agent remembers it.
    resume?: string | undefined;
  },
): AgentCommand {
  const commands = options.role === 'worker' ? (options.commands ?? 'sandboxed') : 'off';
  const command = process.execPath;
  const npmCache = join(configDirectory(), 'npm-cache');
  // The parent chat already watches the project, even while no agent is running.
  const args = [resolve(process.argv[1]!), 'mcp', '--profile', profilePath, '--path', options.project, '--no-sync'];
  const model = options.model ? (runtime === 'codex' ? ['-m', options.model] : ['--model', options.model]) : [];
  const runtimeArgs =
    runtime === 'codex'
      ? [
          'exec',
          ...(options.resume ? ['resume'] : []),
          '--json',
          '--skip-git-repo-check',
          // Skip the member's own Codex config: it adds context to every turn. Sign-in still works.
          '--ignore-user-config',
          ...(commands === 'unrestricted'
            ? ['--dangerously-bypass-approvals-and-sandbox']
            : options.resume
              ? // Resuming has no --sandbox flag.
                ['-c', `sandbox_mode="${commands === 'sandboxed' ? 'workspace-write' : 'read-only'}"`]
              : ['--sandbox', commands === 'sandboxed' ? 'workspace-write' : 'read-only']),
          ...model,
          ...(options.instructions ? ['-c', `developer_instructions=${JSON.stringify(options.instructions)}`] : []),
          '-c',
          // Codex exec cannot ask for approval, so clqn tools that write would otherwise always be refused.
          `mcp_servers.clqn={command=${JSON.stringify(command)},args=${JSON.stringify(args)},default_tools_approval_mode="approve"}`,
          '-c',
          `shell_environment_policy.set.CLQN_AGENT_PROFILE=${JSON.stringify(profilePath)}`,
          ...(options.resume ? [options.resume] : []),
          '-',
        ]
      : [
          '--print',
          ...(options.session
            ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
            : ['--output-format', 'json']),
          ...(options.instructions ? ['--append-system-prompt', options.instructions] : []),
          ...model,
          '--strict-mcp-config',
          '--mcp-config',
          JSON.stringify({ mcpServers: { clqn: { type: 'stdio', command, args } } }),
          // Skip the member's user settings and plugins: they add context to every turn. Workers keep the repo's
          // skills, as if a member had started them there; the orchestrator only needs clqn tools.
          '--setting-sources',
          'project,local',
          // The orchestrator gets no built-in tools, so its clqn tools load up front instead of through a search.
          ...(options.role === 'orchestrator' ? ['--disable-slash-commands', '--tools', ''] : []),
          // Sandboxed workers run commands without prompts inside Claude Code's OS sandbox: writes stay in the
          // worktree (git metadata included, hooks and config excluded) and the network is limited to the npm
          // registry. npm's cache moves out of ~/.npm, which the sandbox blocks, into a directory it may write.
          ...(commands === 'sandboxed' ? ['--settings', JSON.stringify(workerSandbox), '--add-dir', npmCache] : []),
          '--permission-mode',
          commands === 'unrestricted' ? 'bypassPermissions' : options.role === 'worker' ? 'acceptEdits' : 'default',
          '--allowedTools',
          'mcp__clqn',
        ];
  const env: NodeJS.ProcessEnv = { ...process.env, CLQN_AGENT_PROFILE: profilePath };
  if (runtime === 'claude' && commands === 'sandboxed') {
    mkdirSync(npmCache, { recursive: true, mode: 0o700 });
    env.npm_config_cache = npmCache;
  }
  delete env.CLQN_TOKEN;
  delete env.CLQN_CLAN_ID;
  return { command: runtime, args: runtimeArgs, env };
}

type Json = { [key: string]: unknown };
const object = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {});
const count = (...values: unknown[]) =>
  values.reduce<number>((sum, value) => sum + (typeof value === 'number' && value > 0 ? value : 0), 0);

// Total input and output tokens, the final message, and Codex's session ID from a finished run's stdout.
export function agentOutput(
  runtime: Runtime,
  stdout: string,
): { tokens: number; text?: string; error?: string; session?: string } {
  let tokens = 0;
  let text: string | undefined;
  let error: string | undefined;
  let session: string | undefined;
  for (const line of runtime === 'codex' ? stdout.split('\n') : [stdout]) {
    let event: Json;
    try {
      event = object(JSON.parse(line));
    } catch {
      continue;
    }
    // Tokens count everything but cache reads: each API call resends the whole conversation, mostly from the
    // cache, so adding cache reads would count the same context again on every call. See docs/chat.md.
    if (runtime === 'claude') {
      // Claude Code reports usage summed over the run.
      const usage = object(event.usage);
      tokens = count(usage.input_tokens, usage.cache_creation_input_tokens, usage.output_tokens);
      if (typeof event.result === 'string') text = event.result;
      if (event.is_error === true) error = text ?? 'Claude Code reported an error';
    } else if (event.type === 'thread.started') {
      if (typeof event.thread_id === 'string') session = event.thread_id;
    } else if (event.type === 'turn.completed') {
      // Codex input tokens include cached input.
      const usage = object(event.usage);
      tokens += count(usage.input_tokens, usage.output_tokens) - count(usage.cached_input_tokens);
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      const detail = event.type === 'error' ? event.message : object(event.error).message;
      if (typeof detail === 'string') error = detail;
    } else if (event.type === 'item.completed') {
      const item = object(event.item);
      if (item.type === 'agent_message' && typeof item.text === 'string') text = item.text;
    }
  }
  return {
    tokens: Math.min(tokens, Number.MAX_SAFE_INTEGER),
    ...(text?.trim() ? { text: text.trim() } : {}),
    ...(error ? { error: plainError(error) } : {}),
    ...(session ? { session } : {}),
  };
}

// Runtime errors are shown on one status line, so keep them short and free of control characters.
const plainError = (text: string) =>
  text
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')
    .trim()
    .slice(0, 160);

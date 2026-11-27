#!/usr/bin/env node
import { homedir } from 'node:os';
import { serveMcp } from '@clqn/mcp';
import {
  type Agent,
  ApiError,
  type Clan,
  ClqnClient,
  registerAgentSchema,
  repositorySlugSchema,
  resourceAliasSchema,
  VERSION,
} from '@clqn/shared';
import { Command, Option } from 'commander';
import { startAgentRunner } from './agent-runner.js';
import {
  type AgentProfile,
  agentProfilePath,
  type Runtime,
  readAgentProfile,
  runtimes,
  saveAgentProfile,
} from './agent-session.js';
import { runChat } from './chat.js';
import { hostedServer, preferredServer, readConfig, writeConfig } from './config.js';
import { localRepository } from './git.js';
import { removeGithubWebhook } from './github-hooks.js';
import { landingFrame, openLanding } from './landing.js';
import { runMcpSync } from './mcp-sync.js';
import {
  chooseClan,
  deleteClan,
  GoBack,
  linkGithubRepository,
  savedClan,
  selectClan,
  setupChatRepository,
  signIn,
  signOut,
} from './setup.js';
import { runSyncWatch } from './sync-watch.js';
import { terminalText } from './terminal.js';

let serverUrl = hostedServer;
let sessionProfile: AgentProfile | undefined;
const program = new Command()
  .name('clqn')
  .description(
    'Your agents. My agents. One workspace.\nRun clqn with no command to sign in, pick a clan, and open the chat.',
  )
  .version(VERSION)
  .option('--api-url <url>', 'override the saved clqn server for this command')
  .option('--json', 'output machine-readable JSON')
  .option('--verbose', 'show Git and GitHub CLI error output, with credentials redacted')
  .hook('preAction', async (_root, command) => {
    if (program.opts().verbose) process.env.CLQN_VERBOSE = '1';
    const path = command.name() === 'mcp' ? (command.opts().profile as string | undefined) : undefined;
    const profilePath = path ?? process.env.CLQN_AGENT_PROFILE;
    if (profilePath !== undefined) {
      if (command.name() === 'use') throw new Error('Run that command from your personal terminal.');
      sessionProfile = await readAgentProfile(profilePath);
      if (!sessionProfile)
        throw new Error('The saved agent connection is missing. Refresh it from your personal terminal.');
      serverUrl = sessionProfile.server;
      return;
    }
    serverUrl = configuredServer() ?? (await preferredServer());
  });

const configuredServer = () => program.opts<{ apiUrl?: string }>().apiUrl ?? process.env.CLQN_API_URL;
const apiUrl = () => serverUrl;
const verbatim = (value: unknown, text: string) => console.log(program.opts().json ? JSON.stringify(value) : text);
const output = (value: unknown, human: string) => verbatim(value, terminalText(human, process.stdout.isTTY));
const displayId = (value: { id: string; alias?: string | null | undefined }) =>
  value.alias ? `${value.alias} (${value.id})` : value.id;
const defaultAlias = (name: string) => resourceAliasSchema.safeParse(name.trim()).data;
const client = async () =>
  new ClqnClient(apiUrl(), sessionProfile?.token ?? process.env.CLQN_TOKEN ?? (await readConfig(apiUrl())).token);

program
  .command('health')
  .description('Check API liveness (not clan status or database readiness)')
  .action(async () => {
    const health = await new ClqnClient(apiUrl()).health();
    output(health, `${health.service} ${health.version}: ${health.status}`);
  });

const repo = program.command('repo').description('Link GitHub repositories for main-change notifications');
const repoSelection = async (name: string | undefined, options: { repo?: string; path: string }) => {
  if (name && options.repo && name !== options.repo) throw new Error('Provide one repository');
  return name || options.repo
    ? repositorySlugSchema.parse(name ?? options.repo)
    : (await localRepository(options.path)).repository;
};
repo
  .command('link [repository]')
  .description('Connect GitHub main-change webhooks to this clan (leader only)')
  .option('--repo <owner/repo>', 'alternative to positional repository')
  .option('--path <directory>', 'local clone', '.')
  .option('--clan <id>', 'clan ID')
  .action(async (name: string | undefined, options: { repo?: string; path: string; clan?: string }) => {
    const slug = await repoSelection(name, options);
    const clanId = await selectedClan(options);
    const setup = await linkGithubRepository(await client(), apiUrl(), clanId, slug);
    output(setup, `Linked ${slug} to clan ${clanId}.\nMain sync runs while clqn is open in the project clone.`);
  });
repo
  .command('list')
  .description('List this clan’s linked GitHub repositories')
  .option('--clan <id>', 'clan ID')
  .action(async (options: { clan?: string }) => {
    const result = await (await client()).repositories(await selectedClan(options));
    output(
      result,
      result.repositories.map((link) => `${link.slug}  ${link.id}`).join('\n') || 'No linked repositories.',
    );
  });
repo
  .command('unlink [repository]')
  .description('Disable a clan link and remove its GitHub webhook (leader only)')
  .option('--repo <owner/repo>', 'alternative to positional repository')
  .option('--path <directory>', 'local clone', '.')
  .option('--clan <id>', 'clan ID')
  .action(async (name: string | undefined, options: { repo?: string; path: string; clan?: string }) => {
    const slug = await repoSelection(name, options);
    const api = await client();
    const clanId = await selectedClan(options);
    const binding = (await api.repositories(clanId)).repositories.find((link) => link.slug === slug);
    if (!binding) throw new Error('Repository is not linked to this clan');
    // Revoke server access first, which also proves personal leader authorization before touching GitHub.
    await api.unlinkRepository(clanId, binding.id);
    try {
      const removed = await removeGithubWebhook({
        repository: slug,
        url: new URL(`/hooks/github/${binding.id}`, apiUrl()).href,
      });
      output({ unlinked: true, repository: slug, webhookRemoved: removed.removed }, `Unlinked ${slug}.`);
    } catch (error) {
      throw new Error(
        `The clan link is disabled. Remove its old webhook in GitHub repository settings. ${error instanceof Error ? error.message : 'GitHub operation failed'}`,
      );
    }
  });

program
  .command('whoami')
  .description('Show the authenticated human or agent identity')
  .action(async () => {
    const api = await client();
    const user = await api.whoami();
    if (user.agentId) {
      const agent = await api.agentStatus();
      output({ ...user, agent }, `${agent.name} (${agent.role})\nSigned in for ${user.email}`);
    } else output(user, user.email);
  });

program
  .command('clans')
  .description('List your clans')
  .action(async () => {
    const result = await (await client()).listClans();
    const { clanId } = await readConfig(apiUrl());
    const active = sessionProfile?.clanId ?? process.env.CLQN_CLAN_ID ?? clanId;
    output(
      result,
      result.clans.map((clan) => `${clan.name}${clan.id === active ? ' (current)' : ''}`).join('\n') ||
        'No clans yet. Run clqn to create one, or ask a teammate to invite you.',
    );
  });

const findClan = (clans: Clan[], name: string) => {
  const byId = clans.find((clan) => clan.id === name);
  const matches = clans.filter((clan) => clan.name.toLowerCase() === name.toLowerCase());
  if (!byId && matches.length > 1)
    throw new Error('Several clans have that name. Run clqn clans --json and select one by ID.');
  const clan = byId ?? matches[0];
  if (!clan) throw new Error('Clan not found. Run clqn clans to see your clans.');
  return clan;
};
program
  .command('use <clan>')
  .description('Select one of your clans by name')
  .action(async (name: string) => {
    const config = await readConfig(apiUrl());
    const clan = findClan((await (await client()).listClans()).clans, name);
    await writeConfig(apiUrl(), { ...config, clanId: clan.id });
    output(clan, `Using ${clan.name}.`);
  });

program
  .command('invite <email>')
  .description('Invite someone to your clan by email (clan leaders only)')
  .option('--clan <id>', 'clan ID (defaults to the last clan created or joined)')
  .option('--code', 'show a single-use invitation code for older clients')
  .action(async (email: string, options: { clan?: string; code?: boolean }) => {
    const clanId = await selectedClan(options);
    const { code, ...invitation } = await (await client()).createInvitation(clanId, email);
    if (options.code) {
      output(
        { code, ...invitation },
        `Invitation for ${invitation.email}: ${code}\nExpires ${invitation.expiresAt}. Share the code privately with the intended member.`,
      );
    } else {
      output(invitation, `Invited ${invitation.email}. Ask them to run clqn and choose View clan invites.`);
    }
  });

const members = program
  .command('members')
  .description('List clan members')
  .option('--clan <id>', 'clan ID (defaults to the last clan created or joined)')
  .action(async (options: { clan?: string }) => {
    const clanId = await selectedClan(options);
    const result = await (await client()).members(clanId);
    output(result, result.members.map((member) => `${member.email}  ${member.role}`).join('\n') || 'No members.');
  });
type ClanMembers = Awaited<ReturnType<ClqnClient['members']>>['members'];
function memberByReference(members: ClanMembers, member: string) {
  const found = members.find((entry) => entry.userId === member || entry.email === member.trim().toLowerCase());
  if (!found) throw new Error('Member not found in this clan');
  return found;
}
const findMember = async (api: ClqnClient, clanId: string, member: string) =>
  memberByReference((await api.members(clanId)).members, member);
program
  .command('host [members...]')
  .description('List backups or replace the list with member emails or IDs. Use off to clear it (leader only)')
  .option('--clan <id>', 'clan ID')
  .action(async (references: string[], options: { clan?: string }) => {
    if (references.length > 1 && references.includes('off')) throw new Error('Use off by itself to clear backups');
    const api = await client();
    const clanId = await selectedClan(options);
    if (references[0] === 'off') {
      output(await api.setChatBackups(clanId, []), 'Orchestrator backups cleared.');
      return;
    }
    const { members } = await api.members(clanId);
    const result = references.length
      ? await api.setChatBackups(
          clanId,
          references.map((reference) => memberByReference(members, reference).userId),
        )
      : await api.chatBackups(clanId);
    const names = new Map(members.map(({ userId, email }) => [userId, email]));
    output(result, result.userIds.map((id) => names.get(id) ?? id).join('\n') || 'No orchestrator backups.');
  });

members
  .command('remove <member>')
  .description('Remove a member by email or user ID and revoke their agents in the clan (leader only)')
  .action(async (member: string, _options: unknown, command: Command) => {
    const api = await client();
    const clanId = await selectedClan(command.optsWithGlobals());
    const found = await findMember(api, clanId, member);
    output(await api.removeMember(clanId, found.userId), `Removed ${found.email} from clan ${clanId}`);
  });
members
  .command('transfer <member>')
  .description('Make another member, by email or user ID, the clan leader; you become a member (leader only)')
  .action(async (member: string, _options: unknown, command: Command) => {
    const api = await client();
    const clanId = await selectedClan(command.optsWithGlobals());
    const found = await findMember(api, clanId, member);
    output(await api.transferLeadership(clanId, found.userId), `${found.email} now leads clan ${clanId}`);
  });

program
  .command('leave')
  .description('Leave a clan and revoke your agents in it (the leader cannot leave)')
  .option('--clan <id>', 'clan ID')
  .action(async (options: { clan?: string }) => {
    const config = await readConfig(apiUrl());
    const clanId = await selectedClan(options);
    const result = await (await client()).leaveClan(clanId);
    // Clear the selection when it points at the clan just left.
    if (config.clanId === clanId) await writeConfig(apiUrl(), config.token ? { token: config.token } : {});
    output(result, `Left clan ${clanId}`);
  });

program
  .command('delete <clan>')
  .description('Delete a clan by name with its chat, tasks, agents, and repository links (leader only)')
  .action(async (name: string) => {
    const api = await client();
    const clan = findClan((await api.listClans()).clans, name);
    const result = await deleteClan(api, apiUrl(), clan.id);
    const config = await readConfig(apiUrl());
    if (config.clanId === clan.id) await writeConfig(apiUrl(), config.token ? { token: config.token } : {});
    output(
      result,
      `Deleted ${clan.name}.` +
        (result.webhooksLeft.length
          ? `\nRemove its old webhooks in GitHub repository settings: ${result.webhooksLeft.join(', ')}`
          : ''),
    );
  });

const selectedClan = async (options: { clan?: string } = {}) => {
  if (sessionProfile) return options.clan ?? sessionProfile.clanId;
  if (options.clan ?? process.env.CLQN_CLAN_ID) return (options.clan ?? process.env.CLQN_CLAN_ID)!;
  const config = await readConfig(apiUrl());
  // A saved selection already matches a saved token, so only ask the API about an environment token
  // (often an agent's) or a token saved without a clan.
  if (process.env.CLQN_TOKEN || (config.token && !config.clanId)) {
    const actor = await (await client()).whoami();
    if (actor.clanId) return actor.clanId;
  }
  if (config.clanId) return config.clanId;
  throw new Error('Select a clan with clqn use <name>. Run clqn clans to see your clans.');
};
const agent = program.command('agent').description('Register and list agents');
const agentLabel = (entry: Agent) =>
  entry.alias && entry.name !== entry.alias ? `${entry.name} (${entry.alias})` : entry.name;
const agentSummary = (entry: Agent) => ({
  name: entry.name,
  role: entry.role,
  ...(entry.alias ? { alias: entry.alias } : {}),
});
const runtimeOption = () => new Option('--runtime <name>', 'agent runtime').choices(runtimes);
const rememberAgent = async (result: { agent: Agent; token: string }, runtime?: Runtime) => {
  const entry = result.agent;
  try {
    await saveAgentProfile({
      agentId: entry.id,
      clanId: entry.clanId,
      server: apiUrl(),
      token: result.token,
      runtime,
    });
  } catch {
    throw new Error(
      'The agent was saved on the server, but clqn could not save its local connection. Check your clqn config directory and run clqn agent token with the agent name.',
    );
  }
};
agent
  .command('add <name>')
  .description('Register an agent and save its local connection')
  .option('--clan <id>', 'clan ID')
  .option('--alias <alias>', 'short name for assignment (defaults to the name if valid)')
  .option('--orchestrator', 'register an orchestrator for the leader or a nominated backup')
  .addOption(runtimeOption())
  .option('--show-token', 'include the credential for a custom runtime')
  .action(
    async (
      name: string,
      options: { clan?: string; orchestrator?: boolean; alias?: string; runtime?: Runtime; showToken?: boolean },
    ) => {
      const registration = registerAgentSchema.parse({
        name,
        role: options.orchestrator ? 'orchestrator' : 'worker',
        alias: options.alias ?? defaultAlias(name),
      });
      const result = await (await client()).registerAgent(
        await selectedClan(options),
        registration.name,
        registration.role,
        registration.alias,
      );
      await rememberAgent(result, options.runtime);
      const added = `Registered ${agentLabel(result.agent)} as a ${result.agent.role}.`;
      const runs =
        result.agent.role === 'orchestrator'
          ? 'It works the chat queue while you have clqn open.'
          : 'It runs the tasks you approve while you have clqn open.';
      output(
        options.showToken ? result : { agent: agentSummary(result.agent) },
        options.showToken ? `${added}\n${result.token}` : `${added}\n${runs}`,
      );
    },
  );

agent
  .command('list')
  .option('--clan <id>', 'clan ID')
  .action(async (options: { clan?: string }) => {
    const result = await (await client()).listAgents(await selectedClan(options));
    output(
      result,
      result.agents.map((a) => `${agentLabel(a)}  ${a.role}${a.active === false ? '  revoked' : ''}`).join('\n') ||
        'No agents.',
    );
  });
agent
  .command('revoke <agent>')
  .description('Revoke an agent’s tokens (its owner or the clan leader)')
  .option('--clan <id>', 'clan ID')
  .action(async (id: string, options: { clan?: string }) => {
    const result = await (await client()).revokeAgent(await selectedClan(options), id);
    output(result, `Revoked tokens for ${displayId(result.agent)}`);
  });
agent
  .command('token <agent>')
  .description('Refresh an agent’s local connection and invalidate its old credential')
  .option('--clan <id>', 'clan ID')
  .option('--show-token', 'include the credential for a custom runtime')
  .action(async (id: string, options: { clan?: string; showToken?: boolean }) => {
    const result = await (await client()).rotateAgentToken(await selectedClan(options), id);
    const previous = await readAgentProfile(agentProfilePath(apiUrl(), result.agent.id)).catch(() => undefined);
    await rememberAgent(result, previous?.runtime);
    const refreshed = `Refreshed the local connection for ${agentLabel(result.agent)}.`;
    output(
      options.showToken ? result : { agent: agentSummary(result.agent) },
      options.showToken ? `${refreshed}\n${result.token}` : refreshed,
    );
  });
program
  .command('mcp', { hidden: true })
  .description('Start the local stdio MCP server and automatic main sync')
  .option('--path <directory>', 'project clone or worktree (defaults to current directory)', '.')
  .addOption(new Option('--profile <path>').hideHelp())
  .addOption(new Option('--no-sync').hideHelp())
  .action(async (options: { path: string; sync: boolean }) => {
    const api = await client();
    const config = sessionProfile ? {} : await readConfig(apiUrl());
    const actor = sessionProfile || process.env.CLQN_TOKEN || config.token ? await api.whoami() : undefined;
    if (sessionProfile && (actor?.agentId !== sessionProfile.agentId || actor?.clanId !== sessionProfile.clanId))
      throw new Error('The saved connection belongs to a different agent.');
    const clanId = sessionProfile?.clanId ?? process.env.CLQN_CLAN_ID ?? actor?.clanId ?? config.clanId;
    const controller = new AbortController();
    const stop = () => controller.abort();
    const server = await serveMcp(api, clanId, stop);
    const shutdown = () => {
      stop();
      void server.close();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    const onClose = server.server.onclose;
    server.server.onclose = () => {
      onClose?.();
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
    };
    if (!clanId || !options.sync) return;
    let previous = '';
    await runMcpSync(api, clanId, {
      repoPath: options.path,
      signal: controller.signal,
      onResult: (result) => {
        const signature = JSON.stringify(result);
        if (signature !== previous && result.status !== 'unchanged') {
          console.error(`Main sync: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
        }
        previous = signature;
      },
      onError: (error) => console.error(`Main sync: ${error instanceof Error ? error.message : 'failed'}`),
    });
  });

// The one interactive command: sign in if needed, pick or set up a clan, then open the chat.
// Everything before joining a session, including its settings, runs on the full-screen landing page.
async function openChat() {
  const environmentToken = process.env.CLQN_TOKEN !== undefined;
  const project = process.cwd();
  const home = homedir();
  const details: { user?: string; directory: string; repository?: string } = {
    directory: project.startsWith(home) ? `~${project.slice(home.length)}` : project,
  };
  let landing = openLanding(details);
  const know = (changes: { user?: string; repository?: string }) => {
    Object.assign(details, changes);
    landing.update(changes);
  };
  void localRepository(project).then(
    (local) => know({ repository: local.repository }),
    () => undefined,
  );
  const show = (uri: string, code: string) => landing.showGithubLogin(uri, code);
  try {
    if (!environmentToken) {
      const { token } = await readConfig(apiUrl());
      const user =
        token === undefined
          ? undefined
          : await new ClqnClient(apiUrl(), token).whoami().catch((error: unknown) => {
              if (error instanceof ApiError && error.status === 401) return undefined;
              throw error;
            });
      know({ user: (user ?? (await signIn(apiUrl(), undefined, show))).email });
    } else
      void client()
        .then((api) => api.whoami())
        .then(
          (user) => know({ user: user.email }),
          () => undefined,
        );
  } catch (error) {
    landing.close();
    throw error;
  }
  const reauthenticate = (userId: string) => signIn(apiUrl(), userId, show).then(() => undefined);
  // Going back from a later step returns to the clan picker.
  const setup = async () => {
    for (;;) {
      try {
        const { ask, choose, print } = landing;
        let clanId = process.env.CLQN_CLAN_ID;
        // Returning users see the same picker as new ones, with Enter reopening their last clan.
        if (!clanId) {
          const clan = await chooseClan({
            connect: client,
            ask,
            choose,
            print,
            ...(environmentToken ? {} : { reauthenticate }),
            current: await savedClan(apiUrl(), await client()),
          });
          clanId = clan.id;
          await selectClan(apiUrl(), clanId);
        }
        const api = await client();
        const repository = await setupChatRepository({ api, server: apiUrl(), clanId, project, choose, print });
        return { clanId, api, repository };
      } catch (error) {
        if (!(error instanceof GoBack)) throw error;
      }
    }
  };
  for (;;) {
    let chosen: Awaited<ReturnType<typeof setup>>;
    try {
      chosen = await setup();
    } finally {
      landing.close();
    }
    const { clanId, api, repository } = chosen;
    const syncController = new AbortController();
    let repositoryStatus = repository.sync ? 'Checking main…' : undefined;
    const sync =
      repository.sync &&
      runSyncWatch({
        ...repository.sync,
        signal: syncController.signal,
        getEvents: (cursor, signal) => api.events(clanId, cursor, 100, signal),
        onResult: ({ status, reason, branch, headSha }) => {
          const skipped = {
            not_main: 'default branch is not checked out',
            dirty: 'local changes',
            operation_in_progress: 'Git operation in progress',
            local_commits: 'local commits',
            diverged: 'local history has diverged',
            no_local_main: 'no local default branch',
          };
          if (status === 'skipped' && reason) repositoryStatus = `${branch} sync paused · ${skipped[reason]}`;
          else if (status === 'updated' && headSha) repositoryStatus = `${branch} synced to ${headSha.slice(0, 7)}`;
          else repositoryStatus = `${branch} up to date`;
        },
        onError: () => {
          repositoryStatus = 'Main sync unavailable · retrying';
        },
      });
    const agents = startAgentRunner({
      api,
      server: apiUrl(),
      clanId,
      project,
    });
    let result: Awaited<ReturnType<typeof runChat>>;
    try {
      result = await runChat(api, clanId, agents, {
        repositoryStatus: () => repository.notice ?? repositoryStatus,
        page: (view) => landingFrame({ ...view, links: process.env.TERM !== 'dumb', ...details, log: [] }),
        deleteClan: () => deleteClan(api, apiUrl(), clanId),
      });
    } finally {
      syncController.abort();
      await Promise.all([agents.stop(), sync]);
    }
    if (result === 'sign-out') console.log(await signOut(apiUrl()));
    // A deleted clan returns to the clan picker, unless the environment pins that clan.
    if (result !== 'back' && (typeof result !== 'object' || process.env.CLQN_CLAN_ID)) return;
    landing = openLanding(details);
    if (typeof result === 'object') landing.print(result.deleted);
  }
}

try {
  // Keep command parsing and errors unchanged for scripted and explicit invocations.
  const args = process.stdin.isTTY && process.stdout.isTTY ? program.parseOptions(process.argv.slice(2)) : undefined;
  if (args && !args.operands.length && !args.unknown.length && !program.opts().json) {
    if (process.env.CLQN_AGENT_PROFILE !== undefined)
      throw new Error('Open the shared chat from your personal terminal.');
    serverUrl = configuredServer() ?? (await preferredServer());
    await openChat();
  } else {
    await program.parseAsync();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Command failed';
  let humanMessage = message;
  if (error instanceof ApiError && error.status === 401 && !process.env.CLQN_TOKEN) {
    humanMessage = sessionProfile
      ? 'Refresh this agent’s local connection from your personal terminal.'
      : 'Run clqn to sign in, then try again.';
  }
  console.error(
    program.opts().json
      ? JSON.stringify({
          error: {
            code: error instanceof ApiError ? error.code : 'COMMAND_FAILED',
            message,
          },
        })
      : terminalText(`Error: ${humanMessage}`, process.stderr.isTTY),
  );
  process.exitCode = 1;
}

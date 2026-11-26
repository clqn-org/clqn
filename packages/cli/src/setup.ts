import { basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  ApiError,
  allowedModelsSchema,
  type ChatSettings,
  type Clan,
  ClqnClient,
  createClanSchema,
  defaultChatSettings,
  type LinkedRepository,
  limitSchema,
} from '@clqn/shared';
import { type Config, readConfig, removeConfig, writeConfig, writeServer } from './config.js';
import { localRepository } from './git.js';
import { configureGithubWebhook } from './github-hooks.js';
import { githubLogin } from './login.js';
import { terminalText } from './terminal.js';

export type Ask = (question: string) => Promise<string>;
export type Print = (text: string) => void;

// Keep local preferences across sign-ins and remember the server for later runs.
async function saveToken(server: string, token: string) {
  const config = await readConfig(server).catch((): Config => ({}));
  await writeConfig(server, { ...config, token });
  await writeServer(server);
}

export async function signIn(server: string, expectedUserId?: string) {
  const { token, user } = await githubLogin(server);
  if (expectedUserId !== undefined && user.id !== expectedUserId) {
    await new ClqnClient(server, token).logout().catch(() => undefined);
    throw new Error('Sign in with the GitHub account that received the invitation.');
  }
  await saveToken(server, token);
  return user;
}

// Revoke the saved token, then remove the local credential and clan selection even if the API is unreachable.
export async function signOut(server: string) {
  const { token } = await readConfig(server).catch((): Config => ({}));
  let revoked = false;
  if (token)
    revoked = await new ClqnClient(server, token).logout().then(
      (result) => result.revoked,
      () => false,
    );
  await removeConfig(server);
  return [
    'Signed out.',
    token && !revoked ? 'The saved token could not be revoked on the server.' : '',
    process.env.CLQN_TOKEN ? 'CLQN_TOKEN is still set and was not revoked; unset it to stop using that token.' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

// The saved clan, unless the user has left it, was removed, or it was deleted; then forget it so setup asks again.
export async function savedClan(server: string, api: ClqnClient): Promise<string | undefined> {
  const { clanId, ...config } = await readConfig(server);
  if (!clanId) return undefined;
  if ((await api.listClans()).clans.some((clan) => clan.id === clanId)) return clanId;
  await writeConfig(server, config);
  return undefined;
}

export async function selectClan(server: string, clanId: string) {
  await writeConfig(server, { ...(await readConfig(server)), clanId });
}

export async function linkGithubRepository(api: ClqnClient, server: string, clanId: string, slug: string) {
  const { repository, webhook } = await api.linkRepository(clanId, slug);
  try {
    const configured = await configureGithubWebhook({
      repository: slug,
      url: new URL(webhook.path, server).href,
      secret: webhook.secret,
    });
    // Only safe metadata is returned to the CLI output and repository setup.
    return { repository, webhook: configured };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'GitHub operation failed';
    throw new Error(`The clan link was saved. Fix GitHub webhook setup and retry clqn repo link. ${detail}`);
  }
}

interface ChatRepositorySetup {
  sync?: { repoPath: string; repository: string; initialCursor: number };
  notice?: string;
}

export async function setupChatRepository(input: {
  api: ClqnClient;
  server: string;
  clanId: string;
  project: string;
  ask: Ask;
  print: Print;
}): Promise<ChatRepositorySetup> {
  const { api, server, clanId, project, ask, print } = input;
  const local = await localRepository(project).catch(() => undefined);
  if (!local) return { notice: 'Main sync off · open clqn from a GitHub clone' };
  const readLink = async () =>
    (await api.repositories(clanId)).repositories.find(({ slug }) => slug === local.repository);
  const start = (link: LinkedRepository): ChatRepositorySetup => ({
    sync: { repoPath: local.root, repository: link.slug, initialCursor: link.lastEventSequence },
  });
  // Chat info also establishes that setup is running under a personal credential.
  const [{ canStart }, linked] = await Promise.all([api.chatInfo(clanId), readLink().catch(() => null)]);
  if (linked) return start(linked);
  if (linked === null) return { notice: 'Could not read linked repositories · reopen clqn to retry' };
  if (!canStart) return { notice: `Main sync off · ask your clan leader to link ${local.repository}` };
  const skipped = { notice: 'Main sync off · run clqn repo link to enable' };
  const key = `${clanId}:${local.repository}`;
  if ((await readConfig(server)).skippedRepositoryLinks?.includes(key)) return skipped;
  for (;;) {
    const answer = (await ask(`Link ${local.repository} to this clan for pull requests and main sync? [y/N] `))
      .trim()
      .toLowerCase();
    if (answer === 'y' || answer === 'yes') break;
    if (answer !== '' && answer !== 'n' && answer !== 'no') continue;
    const config = await readConfig(server);
    await writeConfig(server, { ...config, skippedRepositoryLinks: [...(config.skippedRepositoryLinks ?? []), key] });
    return skipped;
  }
  try {
    const { repository } = await linkGithubRepository(api, server, clanId, local.repository);
    return start(repository);
  } catch (error) {
    print(terminalText(error instanceof Error ? error.message : 'Could not link the repository', false));
    const saved = await readLink().catch(() => undefined);
    return saved ? { ...start(saved), notice: 'Webhook setup failed · retry clqn repo link' } : skipped;
  }
}

async function pick(ask: Ask, count: number, question: string) {
  for (;;) {
    const answer = (await ask(question)).trim();
    if (!answer) return undefined;
    const choice = Number(answer);
    if (Number.isInteger(choice) && choice >= 1 && choice <= count) return choice - 1;
  }
}

// Blank means no limit. Asks again until the answer is valid.
async function askLimit<T>(ask: Ask, print: Print, question: string, parse: (answer: string) => T | undefined) {
  for (;;) {
    const answer = (await ask(question)).trim();
    const value = answer ? parse(answer) : null;
    if (value !== undefined) return value;
    print('Enter a valid value, or leave it blank for no limit.');
  }
}
const wholeNumber = (answer: string) => {
  const parsed = limitSchema.safeParse(/^\d+$/.test(answer) ? Number(answer) : undefined);
  return parsed.success ? parsed.data : undefined;
};
const modelList = (answer: string) => {
  const parsed = allowedModelsSchema.safeParse(answer.split(',').map((model) => model.trim()));
  return parsed.success ? parsed.data : undefined;
};

// New members, including the leader of a new clan, choose their limits. Approvals still apply either way.
export async function chooseLimits(api: ClqnClient, clanId: string, ask: Ask, print: Print) {
  print('\nLimits for agents on your machine\n  1. Full access (no limits)\n  2. Custom');
  let settings: ChatSettings = defaultChatSettings;
  if ((await pick(ask, 2, 'Enter a number (1): ')) === 1) {
    settings = {
      ...settings,
      tokenLimit: await askLimit(ask, print, 'Token limit (blank for none): ', wholeNumber),
      agentLimit: await askLimit(ask, print, 'Agent count (blank for none): ', wholeNumber),
      allowedModels: await askLimit(ask, print, 'Allowed models, comma-separated (blank for any): ', modelList),
    };
  }
  await api.saveChatSettings(clanId, settings);
  print('Saved. Change your limits later with Ctrl+S in the chat.');
}

interface ChooseClan {
  server: string;
  connect: () => Promise<ClqnClient>;
  ask: Ask;
  print: Print;
  // False when an environment token is in use, which a new GitHub sign-in would not replace.
  canSignIn: boolean;
  // The last clan used; Enter picks it.
  current?: string | undefined;
}

// Offer the user's clans, creating a clan, or accepting a pending invitation.
export async function chooseClan({ server, connect, ask, print, canSignIn, current }: ChooseClan): Promise<Clan> {
  const text = (value: string) => terminalText(value, false);
  for (;;) {
    let api = await connect();
    // Older servers ask for a fresh GitHub sign-in for invitations sent after this one; sign in, then retry.
    const reverify = async (error: unknown, message: string) => {
      if (!(error instanceof ApiError) || error.code !== 'INVITATION_LOGIN_REQUIRED' || !canSignIn) throw error;
      const user = await api.whoami();
      print(message);
      await signIn(server, user.id);
      api = await connect();
    };
    const { clans } = await api.listClans();
    const last = clans.find((clan) => clan.id === current);
    const choices = [
      ...clans.map((clan) => text(clan.name) + (clan === last ? ' (last used)' : '')),
      'Create a clan',
      'Join a clan',
    ];
    print(`\nChoose a clan\n${choices.map((choice, index) => `  ${index + 1}. ${choice}`).join('\n')}`);
    const question = last ? `Enter a number (Enter for ${text(last.name)}): ` : 'Enter a number: ';
    const choice = await pick(ask, choices.length, question);
    if (choice === undefined) {
      if (last) return last;
      continue;
    }
    if (choice < clans.length) return clans[choice]!;
    if (choice === clans.length) {
      const fallback = basename(process.cwd()).trim().slice(0, 100) || 'My project';
      const name = (await ask(`Clan name (${text(fallback)}): `)).trim() || fallback;
      const parsed = createClanSchema.safeParse({ name });
      if (!parsed.success) {
        print('Enter a clan name of up to 100 characters.');
        continue;
      }
      const clan = await api.createClan(parsed.data.name);
      await chooseLimits(api, clan.id, ask, print);
      return clan;
    }
    const { invitations } = await api.listInvitations().catch(async (error: unknown) => {
      await reverify(error, 'Verify your GitHub email to see your invitations.');
      return api.listInvitations();
    });
    if (!invitations.length) {
      const { email } = await api.whoami();
      print(text(`No pending invitations. Ask a clan leader to invite ${email}.`));
      continue;
    }
    print(`\nPending invitations\n${invitations.map((entry, i) => `  ${i + 1}. ${text(entry.clanName)}`).join('\n')}`);
    const index = await pick(ask, invitations.length, 'Enter a number (Enter to go back): ');
    if (index === undefined) continue;
    const { clanId } = invitations[index]!;
    const clan = await api.acceptInvitation(clanId).catch(async (error: unknown) => {
      await reverify(error, 'Verify your GitHub email to accept this invitation.');
      return api.acceptInvitation(clanId);
    });
    await chooseLimits(api, clan.id, ask, print);
    return clan;
  }
}

// Plain line prompts before the full-screen chat opens. Ctrl+C or Ctrl+D quits.
export function terminalPrompt() {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let done = false;
  const quit = () => {
    if (done) return;
    process.stdout.write('\n');
    process.exit(130);
  };
  prompt.on('SIGINT', quit);
  prompt.on('close', quit);
  return {
    ask: (question: string) => prompt.question(question),
    close: () => {
      done = true;
      prompt.close();
    },
  };
}

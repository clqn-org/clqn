import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';

const cliPath = fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url));

type ActivityEvent = { type: string; sequence: number; agentId: string | null; resourceId: string | null };

test('MVP acceptance: two people and two stdio agents share context, coordinate work, and observe progress', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
  timeout: 30_000,
}, async (t) => {
  const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 5 });
  const db = drizzle(sql);
  const connection = createStore(process.env.TEST_DATABASE_URL!);
  const directory = await mkdtemp(join(tmpdir(), 'clqn-acceptance-'));
  const userIds: string[] = [];
  const clanIds: string[] = [];
  const clients: Client[] = [];
  let server: ReturnType<typeof serve> | undefined;
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    if (server) await new Promise((resolve) => server?.close(resolve));
    try {
      if (clanIds.length) {
        await sql`delete from events where clan_id in ${sql(clanIds)}`;
        await sql`delete from context_revisions where clan_id in ${sql(clanIds)}`;
        await sql`delete from context_entries where clan_id in ${sql(clanIds)}`;
        await sql`delete from tasks where clan_id in ${sql(clanIds)}`;
        await sql`delete from invitations where clan_id in ${sql(clanIds)}`;
        await sql`delete from credentials where user_id in ${sql(userIds)}`;
        await sql`delete from agents where clan_id in ${sql(clanIds)}`;
        await sql`delete from memberships where clan_id in ${sql(clanIds)}`;
        await sql`delete from clans where id in ${sql(clanIds)}`;
      }
      if (userIds.length) {
        await sql`delete from credentials where user_id in ${sql(userIds)}`;
        await sql`delete from users where id in ${sql(userIds)}`;
      }
    } finally {
      await connection.close();
      await sql.end();
      await rm(directory, { recursive: true, force: true });
    }
  });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const alice = await connection.provisionUser(`${randomUUID()}@example.com`);
  const bob = await connection.provisionUser(`${randomUUID()}@example.com`);
  userIds.push(alice.user.id, bob.user.id);
  server = serve({ fetch: createApp(connection.store, db).fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  delete baseEnv.CLQN_TOKEN;
  delete baseEnv.CLQN_CLAN_ID;
  const aliceEnv = { ...baseEnv, CLQN_CONFIG_DIR: join(directory, 'alice') };
  const bobEnv = { ...baseEnv, CLQN_CONFIG_DIR: join(directory, 'bob') };
  const runRaw = async (env: Record<string, string>, args: string[], input?: string) => {
    const command = promisify(execFile)(process.execPath, [cliPath, '--api-url', apiUrl, '--json', ...args], { env });
    command.child.stdin?.end(input);
    return (await command).stdout;
  };
  const run = async (env: Record<string, string>, args: string[], input?: string) =>
    JSON.parse(await runRaw(env, args, input));
  await run(aliceEnv, ['login'], alice.token);
  await run(bobEnv, ['login'], bob.token);
  const clan = await run(aliceEnv, ['init', 'Two-agent acceptance']);
  clanIds.push(clan.id);
  const invitation = await run(aliceEnv, ['invite', bob.user.email]);
  assert.equal((await run(bobEnv, ['join', invitation.code])).id, clan.id);
  const codex = await run(aliceEnv, ['agent', 'add', 'Codex']);
  const claude = await run(bobEnv, ['agent', 'add', 'claude']);
  assert.equal(claude.agent.alias, 'claude');
  assert.equal(codex.agent.ownerId, alice.user.id);
  assert.equal(claude.agent.ownerId, bob.user.id);
  const codexEnv = { ...aliceEnv, CLQN_TOKEN: codex.token, CLQN_CLAN_ID: clan.id };
  const claudeEnv = { ...bobEnv, CLQN_TOKEN: claude.token, CLQN_CLAN_ID: clan.id };
  assert.equal((await run(codexEnv, ['whoami'])).agent.id, codex.agent.id);
  assert.equal((await run(bobEnv, ['agent', 'list'])).agents.length, 2);
  // An agent's scope wins over an unrelated clan saved by its human owner.
  const otherEnv = { ...baseEnv, CLQN_CONFIG_DIR: join(directory, 'other-human-clan') };
  await run(otherEnv, ['login'], alice.token);
  const otherClan = await run(otherEnv, ['init', 'Unrelated personal selection']);
  clanIds.push(otherClan.id);
  const scopedCodexEnv: Record<string, string> = { ...otherEnv, CLQN_TOKEN: codex.token };
  assert.equal(scopedCodexEnv.CLQN_CLAN_ID, undefined);
  const scopedMembers = await run(scopedCodexEnv, ['members']);
  assert.deepEqual(new Set(scopedMembers.members.map((member: { userId: string }) => member.userId)), new Set(userIds));
  const cleanAgentEnv = { ...baseEnv, CLQN_CONFIG_DIR: join(directory, 'agent-only'), CLQN_TOKEN: codex.token };
  assert.equal((await run(cleanAgentEnv, ['members'])).members.length, 2);
  const connectMcp = async (name: string, env: Record<string, string>) => {
    const client = new Client({ name, version: '1.0.0' });
    clients.push(client);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, '--api-url', apiUrl, 'mcp'],
      cwd: directory,
      env,
      stderr: 'pipe',
    });
    (transport.stderr as Readable | null)?.resume();
    await client.connect(transport);
    return client;
  };
  const [aliceMcp, bobMcp] = await Promise.all([
    connectMcp('codex-acceptance', scopedCodexEnv),
    connectMcp('claude-acceptance', claudeEnv),
  ]);
  const expectedTools = [
    'clqn_read_context',
    'clqn_write_context',
    'clqn_list_context',
    'clqn_create_task',
    'clqn_claim_task',
    'clqn_complete_task',
    'clqn_list_tasks',
    'clqn_get_status',
  ];
  const listed = new Set((await aliceMcp.listTools()).tools.map((tool) => tool.name));
  for (const name of expectedTools) assert.ok(listed.has(name), `Missing MCP tool ${name}`);
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const content = response.content as { text: string }[] | undefined;
    assert.notEqual(response.isError, true, `MCP ${name} failed: ${content?.[0]?.text}`);
    return JSON.parse(content?.[0]?.text ?? '');
  };
  assert.equal((await call(aliceMcp, 'clqn_get_status')).clan.id, clan.id);
  const initial = await run(
    codexEnv,
    ['context', 'write', 'implementation', '--expected-revision', '0'],
    'Alice: API work ready.',
  );
  assert.equal(initial.revision, 1);
  assert.equal((await call(bobMcp, 'clqn_read_context', { key: 'implementation' })).text, 'Alice: API work ready.');
  await call(bobMcp, 'clqn_write_context', {
    key: 'implementation',
    text: 'Bob: CLI work ready too.',
    expectedRevision: 1,
  });
  assert.equal((await call(aliceMcp, 'clqn_read_context', { key: 'implementation' })).revision, 2);
  assert.equal((await run(codexEnv, ['context', 'read', 'implementation'])).text, 'Bob: CLI work ready too.');
  assert.equal((await run(claudeEnv, ['context', 'history', 'implementation'])).revisions.length, 2);
  assert.equal((await call(aliceMcp, 'clqn_list_context')).entries.length, 1);
  const task = await call(aliceMcp, 'clqn_create_task', {
    description: 'Review shared implementation',
    alias: 'review',
  });
  assert.equal(
    (await run(aliceEnv, ['task', 'assign', 'review', '--agent', 'claude'])).assignedAgentId,
    claude.agent.id,
  );
  assert.equal((await call(bobMcp, 'clqn_claim_task', { taskId: 'review' })).ownerAgentId, claude.agent.id);
  const denied = await aliceMcp.callTool({ name: 'clqn_complete_task', arguments: { taskId: task.id } });
  assert.equal(denied.isError, true);
  assert.equal((await run(claudeEnv, ['task', 'release', task.id])).status, 'open');
  assert.equal((await run(codexEnv, ['task', 'start', task.id])).ownerAgentId, codex.agent.id);
  assert.equal((await call(aliceMcp, 'clqn_complete_task', { taskId: task.id })).status, 'completed');
  const secondTask = await run(bobEnv, ['task', 'add', 'confirm']);
  assert.equal(secondTask.alias, 'confirm');
  assert.equal(secondTask.description, 'confirm');
  assert.equal((await run(aliceEnv, ['task', 'alias', 'confirm', 'verify'])).id, secondTask.id);
  assert.equal((await run(bobEnv, ['agent', 'alias', 'claude', 'reviewer'])).id, claude.agent.id);
  await call(bobMcp, 'clqn_claim_task', { taskId: 'verify' });
  assert.equal((await call(bobMcp, 'clqn_complete_task', { taskId: secondTask.id })).status, 'completed');
  assert.equal((await call(aliceMcp, 'clqn_list_tasks')).tasks.length, 2);
  assert.equal((await run(aliceEnv, ['task', 'list'])).tasks.length, 2);
  const status = await run(aliceEnv, ['status']);
  assert.equal(status.clan.id, clan.id);
  assert.deepEqual(status.stats, { members: 2, agents: 2, tasks: { open: 0, claimed: 0, completed: 2 } });
  assert.equal('recentActivity' in status, false);
  const log: { events: ActivityEvent[] } = await run(bobEnv, ['log']);
  assert.ok(log.events.some((event) => event.type === 'task.completed'));
  assert.ok(log.events.every((event, i) => i === 0 || event.sequence < log.events[i - 1]!.sequence));
  assert.equal((await call(bobMcp, 'clqn_get_status')).stats.tasks.completed, 2);
  const events: ActivityEvent[] = (
    await (
      await fetch(`${apiUrl}/v1/clans/${clan.id}/events`, { headers: { authorization: `Bearer ${bob.token}` } })
    ).json()
  ).events;
  assert.ok(events.some((event) => event.type === 'context.written' && event.agentId === codex.agent.id));
  assert.ok(events.some((event) => event.type === 'context.written' && event.agentId === claude.agent.id));
  assert.ok(events.some((event) => event.type === 'task.completed' && event.resourceId === task.id));
  assert.ok(events.every((event, i) => i === 0 || event.sequence > events[i - 1]!.sequence));
});

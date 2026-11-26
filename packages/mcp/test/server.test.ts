import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ClqnClient } from '@clqn/shared';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sourceNodeArgs } from '../../../scripts/test-node.js';
import { createApp } from '../../api/src/app.js';
import { createMcpServer } from '../src/index.js';

// Tests stub only the client methods each tool uses.
const stub = (methods: Partial<ClqnClient>) => methods as unknown as ClqnClient;
const resultJson = (result: object) => JSON.parse((result as { content: [{ text: string }] }).content[0].text);

test('MCP attaches the receipt for the selected chat message to its decision', async (t) => {
  const clanId = randomUUID();
  const messageId = randomUUID();
  const pickId = randomUUID();
  const next = {
    id: messageId,
    sequence: 1,
    authorId: randomUUID(),
    author: 'member@example.com',
    role: 'member' as const,
    createdAt: new Date().toISOString(),
    text: 'Run this first',
    status: 'queued' as const,
    replyTo: null,
  };
  const calls: unknown[] = [];
  const server = createMcpServer(
    stub({
      chatInbox: async () => ({ messages: [], before: null, held: [], next, pickId }),
      decideChat: async (...args) => {
        calls.push(args);
        return { status: 'handled', blocker: null };
      },
    }),
    clanId,
  );
  const client = new Client({ name: 'chat-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const inbox = await client.callTool({ name: 'clqn_chat_inbox', arguments: {} });
  assert.equal(resultJson(inbox).pickId, undefined);
  const decision = { action: 'reply', text: 'Done' };
  const decide = (id: string) => client.callTool({ name: 'clqn_chat_decide', arguments: { messageId: id, decision } });
  assert.equal((await decide(randomUUID())).isError, true);
  assert.equal((await decide(messageId)).isError, undefined);
  assert.deepEqual(calls, [[clanId, messageId, { ...decision, pickId }, undefined]]);
});

test('MCP discovers and calls the health tool through the protocol', async (t) => {
  const health = { status: 'ok' as const, service: 'clqn-api' as const, version: '0.1.0' };
  const server = createMcpServer(stub({ health: async () => health }));
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === 'clqn_list_agents' && tool.annotations?.readOnlyHint));
  assert.ok(tools.some((tool) => tool.name === 'clqn_get_status'));
  assert.ok(tools.some((tool) => tool.name === 'clqn_write_context'));
  const result = await client.callTool({ name: 'clqn_health', arguments: {} });
  assert.deepEqual(resultJson(result), health);
});

test('CLI stdio MCP process reaches the real HTTP API', async (t) => {
  const http = serve({ fetch: createApp().fetch, hostname: '127.0.0.1', port: 0 });
  await once(http, 'listening');
  t.after(() => new Promise((resolve) => http.close(resolve)));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      ...sourceNodeArgs,
      fileURLToPath(new URL('../../cli/src/index.ts', import.meta.url)),
      '--api-url',
      `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
      'mcp',
    ],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const result = await client.callTool({ name: 'clqn_health', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(resultJson(result).service, 'clqn-api');
});

test('MCP lists agents with their owners’ allowed models and has no policy tool', async (t) => {
  const clanId = 'e6faf7c5-0b04-45de-8eba-c1fda2a17a89';
  const agents = [{ id: clanId, name: 'Worker', allowedModels: ['provider/model'] }];
  const server = createMcpServer(
    stub({
      listAgents: async (id) => {
        assert.equal(id, clanId);
        return { agents } as unknown as Awaited<ReturnType<ClqnClient['listAgents']>>;
      },
    }),
    clanId,
  );
  const client = new Client({ name: 'agents-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  assert.ok(!tools.some((tool) => /policy/.test(tool.name)));
  const result = await client.callTool({ name: 'clqn_list_agents', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(resultJson(result), { agents });
});

test('MCP forwards repository assignments and authenticated reports with the exact head revisions', async (t) => {
  const clanId = 'e6faf7c5-0b04-45de-8eba-c1fda2a17a89';
  const taskId = 'f1796d17-12d5-4620-ad88-e285713350a1';
  const agentId = '2ab811b5-a0aa-4310-9ee8-63191d37acfa';
  const repository = { slug: 'test/project', baseBranch: 'main', baseSha: 'a'.repeat(40), branch: 'clqn/task-one' };
  const calls: { name: string; args: unknown[] }[] = [];
  const api = Object.fromEntries(
    [
      'createTask',
      'task',
      'assignTask',
      'unassignTask',
      'setTaskAlias',
      'reportTaskRepository',
      'integrateTask',
      'listTasks',
      'events',
    ].map((name) => [
      name,
      async (...args: unknown[]) => {
        calls.push({ name, args });
        return { ok: true };
      },
    ]),
  );
  const server = createMcpServer(stub(api), clanId);
  const client = new Client({ name: 'repository-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const report = {
    expectedHeadSha: null,
    headSha: 'b'.repeat(40),
    prNumber: 7,
    prUrl: 'https://github.com/test/project/pull/7',
  };
  const integration = { headSha: report.headSha, mergeCommitSha: 'c'.repeat(40) };
  for (const [name, args] of <[string, Record<string, unknown>][]>[
    ['clqn_create_task', { description: 'Work', repository, alias: 'login-fix' }],
    ['clqn_get_task', { taskId }],
    ['clqn_assign_task', { taskId: 'login-fix', agentId: 'codex' }],
    ['clqn_unassign_task', { taskId, agentId }],
    ['clqn_set_task_alias', { taskId: 'login-fix', alias: 'fix-signin' }],
    ['clqn_report_task_repository', { taskId, ...report }],
    ['clqn_record_task_integration', { taskId, ...integration }],
    ['clqn_list_tasks', {}],
    ['clqn_list_tasks', { status: 'open', mine: true, limit: 5, after: taskId }],
    ['clqn_list_events', {}],
    ['clqn_list_events', { cursor: 12, limit: 3 }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
  }
  assert.deepEqual(calls, [
    { name: 'createTask', args: [clanId, 'Work', repository, 'login-fix'] },
    { name: 'task', args: [clanId, taskId] },
    { name: 'assignTask', args: [clanId, 'login-fix', 'codex'] },
    { name: 'unassignTask', args: [clanId, taskId, agentId] },
    { name: 'setTaskAlias', args: [clanId, 'login-fix', 'fix-signin'] },
    { name: 'reportTaskRepository', args: [clanId, taskId, report] },
    { name: 'integrateTask', args: [clanId, taskId, integration] },
    { name: 'listTasks', args: [clanId, { status: undefined, mine: undefined, limit: 50, after: undefined }] },
    { name: 'listTasks', args: [clanId, { status: 'open', mine: true, limit: 5, after: taskId }] },
    { name: 'events', args: [clanId, 0, 50] },
    { name: 'events', args: [clanId, 12, 3] },
  ]);
});

test('MCP attaches the session lease to chat requests without adding it to tool inputs', async (t) => {
  const clanId = 'e6faf7c5-0b04-45de-8eba-c1fda2a17a89';
  const leaseId = '88bedf00-3e13-4a42-ad1b-3018f675c7c5';
  const messageId = 'f1796d17-12d5-4620-ad88-e285713350a1';
  const decision = { action: 'reply', text: 'Queued work resumed' } as const;
  const calls: unknown[][] = [];
  const server = createMcpServer(
    stub({
      chatInbox: async (...args) => {
        calls.push(args);
        return { before: null, messages: [], next: null, held: [] };
      },
      decideChat: async (...args) => {
        calls.push(args);
        return { status: 'handled', blocker: null };
      },
    }),
    clanId,
    leaseId,
  );
  const client = new Client({ name: 'orchestrator-host-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  assert.ok(
    tools
      .filter(({ name }) => ['clqn_chat_inbox', 'clqn_chat_decide'].includes(name))
      .every(({ inputSchema }) => !('leaseId' in (inputSchema.properties ?? {}))),
  );
  assert.equal((await client.callTool({ name: 'clqn_chat_inbox', arguments: {} })).isError, undefined);
  assert.equal(
    (await client.callTool({ name: 'clqn_chat_decide', arguments: { messageId, decision } })).isError,
    undefined,
  );
  assert.deepEqual(calls, [
    [clanId, leaseId],
    [clanId, messageId, decision, leaseId],
  ]);
});

test('the orchestrator inbox shows images attached to the next message', async (t) => {
  const clanId = randomUUID();
  const image = { id: randomUUID(), name: 'screen.png', type: 'image/png' as const, size: 3 };
  const pdf = { id: randomUUID(), name: 'spec.pdf', type: 'application/pdf' as const, size: 3 };
  const next = {
    id: randomUUID(),
    sequence: 1,
    authorId: randomUUID(),
    author: 'member@example.com',
    role: 'member' as const,
    createdAt: new Date().toISOString(),
    text: 'Build [Image #1] per [PDF #2: spec.pdf]',
    status: 'queued' as const,
    replyTo: null,
    attachments: [image, pdf],
  };
  const downloads: string[] = [];
  const server = createMcpServer(
    stub({
      chatInbox: async () => ({ messages: [], before: null, held: [], next, pickId: randomUUID() }),
      chatAttachment: async (_clan, id) => {
        downloads.push(id);
        return { ...image, data: Buffer.from('png').toString('base64') };
      },
    }),
    clanId,
  );
  const client = new Client({ name: 'attachments-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const inbox = await client.callTool({ name: 'clqn_chat_inbox', arguments: {} });
  assert.deepEqual(downloads, [image.id]);
  const content = inbox.content as { type: string; data?: string; mimeType?: string }[];
  assert.equal(resultJson(inbox).next.attachments.length, 2);
  assert.deepEqual(content[1], { type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' });
  assert.equal(content.length, 2);
});

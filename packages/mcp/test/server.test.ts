import assert from 'node:assert/strict';
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
  assert.ok(tools.some((tool) => tool.name === 'clqn_get_policy'));
  assert.ok(!tools.some((tool) => /set_policy|update_policy/.test(tool.name)));
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

test('MCP reads the owner policy without exposing policy mutation', async (t) => {
  const clanId = 'e6faf7c5-0b04-45de-8eba-c1fda2a17a89';
  const policy = {
    tokenLimit: 1000,
    allowedModels: ['provider/model'],
    control: 'approve' as const,
    enforcement: 'unavailable' as const,
  };
  const server = createMcpServer(
    stub({
      policy: async (id) => {
        assert.equal(id, clanId);
        return { ...policy, clanId, userId: clanId, revision: 0 };
      },
    }),
    clanId,
  );
  const client = new Client({ name: 'policy-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: 'clqn_get_policy', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(resultJson(result), { ...policy, clanId, userId: clanId, revision: 0 });
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

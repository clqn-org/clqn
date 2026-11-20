import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { serve } from '@hono/node-server';
import { createApp } from '../../api/dist/app.js';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

test('MCP discovers and calls the health tool through the protocol', async (t) => {
  const health = { status: 'ok', service: 'clqn-api', version: '0.1.0' };
  const server = createMcpServer({ health: async () => health });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === 'clqn_list_agents' && tool.annotations.readOnlyHint));
  assert.ok(tools.some((tool) => tool.name === 'clqn_get_policy'));
  assert.ok(!tools.some((tool) => /set_policy|update_policy/.test(tool.name)));
  assert.ok(tools.some((tool) => tool.name === 'clqn_get_status'));
  assert.ok(tools.some((tool) => tool.name === 'clqn_write_context'));
  const result = await client.callTool({ name: 'clqn_health', arguments: {} });
  assert.deepEqual(JSON.parse(result.content[0].text), health);
});

test('CLI stdio MCP process reaches the real HTTP API', async (t) => {
  const http = serve({ fetch: createApp().fetch, hostname: '127.0.0.1', port: 0 });
  await once(http, 'listening');
  t.after(() => new Promise((resolve) => http.close(resolve)));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url)),
      '--api-url', `http://127.0.0.1:${http.address().port}`, 'mcp'],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const result = await client.callTool({ name: 'clqn_health', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).service, 'clqn-api');
});


test('MCP reads the owner policy without exposing policy mutation', async (t) => {
  const clanId = 'e6faf7c5-0b04-45de-8eba-c1fda2a17a89';
  const policy = { tokenLimit: 1000, allowedModels: ['provider/model'], control: 'approve', enforcement: 'unavailable' };
  const server = createMcpServer({ policy: async (id) => { assert.equal(id, clanId); return policy; } }, clanId);
  const client = new Client({ name: 'policy-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: 'clqn_get_policy', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), policy);
});

test('MCP forwards repository assignments and authenticated reports with the exact head revisions', async (t) => {
  const clanId = 'e6faf7c5-0b04-45de-8eba-c1fda2a17a89';
  const taskId = 'f1796d17-12d5-4620-ad88-e285713350a1';
  const agentId = '2ab811b5-a0aa-4310-9ee8-63191d37acfa';
  const repository = { slug: 'test/project', baseBranch: 'main', baseSha: 'a'.repeat(40), branch: 'clqn/task-one' };
  const calls = [];
  const api = Object.fromEntries(['createTask', 'task', 'assignTask', 'unassignTask', 'setTaskAlias', 'reportTaskRepository', 'integrateTask'].map((name) =>
    [name, async (...args) => { calls.push({ name, args }); return { ok: true }; }]));
  const server = createMcpServer(api, clanId);
  const client = new Client({ name: 'repository-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const report = { expectedHeadSha: null, headSha: 'b'.repeat(40), prNumber: 7, prUrl: 'https://github.com/test/project/pull/7' };
  const integration = { headSha: report.headSha, mergeCommitSha: 'c'.repeat(40) };
  for (const [name, args] of [
    ['clqn_create_task', { description: 'Work', repository, alias: 'login-fix' }], ['clqn_get_task', { taskId }],
    ['clqn_assign_task', { taskId: 'login-fix', agentId: 'codex' }], ['clqn_unassign_task', { taskId, agentId }],
    ['clqn_set_task_alias', { taskId: 'login-fix', alias: 'fix-signin' }],
    ['clqn_report_task_repository', { taskId, ...report }], ['clqn_record_task_integration', { taskId, ...integration }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
  }
  assert.deepEqual(calls, [
    { name: 'createTask', args: [clanId, 'Work', repository, 'login-fix'] }, { name: 'task', args: [clanId, taskId] },
    { name: 'assignTask', args: [clanId, 'login-fix', 'codex'] }, { name: 'unassignTask', args: [clanId, taskId, agentId] },
    { name: 'setTaskAlias', args: [clanId, 'login-fix', 'fix-signin'] },
    { name: 'reportTaskRepository', args: [clanId, taskId, report] }, { name: 'integrateTask', args: [clanId, taskId, integration] },
  ]);
});

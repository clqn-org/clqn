import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { renderMetrics } from '../dist/metrics.js';

const stats = { members: 2, agents: 3, tasks: { open: 5, claimed: 3, completed: 12 } };
const clan = { id: '84367b51-14c7-43de-84a1-faf0207eadb3', name: 'Example clan' };
const status = { clan, stats, recentActivity: [{
  sequence: 1, id: clan.id, clanId: clan.id, actorId: clan.id, agentId: null,
  resourceId: clan.id, type: 'task.completed', createdAt: '2026-11-18T16:30:00.000Z',
}] };

test('metrics show proportional task bars and completion totals', () => {
  const output = renderMetrics(stats);
  assert.match(output, /2 members  \/  3 agents/);
  assert.match(output, /TASKS \/ 20 total/);
  assert.match(output, /Open\s+\[#{8}\.{24}\]\s+5\s+25%/);
  assert.match(output, /Claimed\s+\[#{5}\.{27}\]\s+3\s+15%/);
  assert.match(output, /Completed\s+\[#{19}\.{13}\]\s+12\s+60%/);
  assert.match(output, /60% complete \/ 8 remaining/);
  assert.match(output, /Token usage \/ cost: not collected/);
});

test('empty metrics and activity do not imply collected token usage or invalid percentages', () => {
  const output = renderMetrics({ ...status, stats: { members: 0, agents: 0, tasks: { open: 0, claimed: 0, completed: 0 } }, recentActivity: [] });
  assert.match(output, /No tasks yet/);
  assert.match(output, /No activity yet/);
  assert.equal((output.match(/0%/g) ?? []).length, 3);
  assert.doesNotMatch(output, /NaN|Infinity|undefined/);
  const complete = renderMetrics({ ...stats, tasks: { open: 0, claimed: 0, completed: 1 } });
  assert.match(complete, /Completed\s+\[#{32}\]\s+1\s+100%/);
  assert.match(complete, /100% complete \/ 0 remaining/);
});

test('status fits charts to narrow terminals and neutralizes control characters', () => {
  const output = renderMetrics({ ...status, clan: { ...clan, name: '\x1b[2J\n' + 'Long clan '.repeat(10) },
    recentActivity: [{ ...status.recentActivity[0], type: 'task.completed\x1b[2J' }] }, 40);
  assert.ok(output.split('\n').every((line) => Array.from(line).length <= 40));
  assert.doesNotMatch(output, /\x1b/);
  assert.match(output, /11-18 16:30Z  task.completed/);
  assert.match(output, /resource:/);
});

test('stats aliases use the selected clan endpoint and preserve JSON contracts', async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.url.endsWith('/status') ? status : stats));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const run = promisify(execFile);
  const call = (command, json) => run(process.execPath, [cli, '--api-url', `http://127.0.0.1:${server.address().port}`,
    command, '--clan', clan.id, ...(json ? ['--json'] : [])]);
  for (const command of ['stats', 'metrics', 'metric', 'usage', 'status']) {
    const human = await call(command, false);
    assert.match(human.stdout, /TASKS \/ 20 total/);
    assert.equal(human.stderr, '');
    if (command === 'status') assert.match(human.stdout, /Example clan[\s\S]*task.completed/);
    const json = await call(command, true);
    assert.deepEqual(JSON.parse(json.stdout), command === 'status' ? status : stats);
    assert.equal(json.stderr, '');
  }
  assert.deepEqual(requests, ['stats', 'stats', 'stats', 'stats', 'stats', 'stats', 'stats', 'stats', 'status', 'status']
    .map((route) => `/v1/clans/${clan.id}/${route}`));
});

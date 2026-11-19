import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { renderMetrics, renderActivity } from '../dist/metrics.js';

const stats = { members: 2, agents: 3, tasks: { open: 5, claimed: 3, completed: 12 } };
const clan = { id: '84367b51-14c7-43de-84a1-faf0207eadb3', name: 'Example clan' };
const status = { clan, stats, recentActivity: [{
  sequence: 1, id: clan.id, clanId: clan.id, actorId: clan.id, agentId: null,
  resourceId: clan.id, type: 'task.completed', createdAt: '2026-11-18T16:30:00.000Z',
}] };

test('metrics show proportional task bars and completion totals', () => {
  const output = renderMetrics(status);
  assert.match(output, /2 members  \/  3 agents/);
  assert.match(output, /TASKS \/ 20 total/);
  assert.match(output, /Open\s+\[#{8}\.{24}\]\s+5\s+25%/);
  assert.match(output, /Claimed\s+\[#{5}\.{27}\]\s+3\s+15%/);
  assert.match(output, /Completed\s+\[#{19}\.{13}\]\s+12\s+60%/);
  assert.match(output, /60% complete \/ 8 remaining/);
  assert.match(output, /Token usage \/ cost: not collected/);
});

test('empty metrics do not imply collected token usage or invalid percentages', () => {
  const output = renderMetrics({ ...status, stats: { members: 0, agents: 0, tasks: { open: 0, claimed: 0, completed: 0 } }, recentActivity: [] });
  assert.match(output, /No tasks yet/);
  assert.doesNotMatch(output, /ACTIVITY|activity/);
  assert.equal((output.match(/0%/g) ?? []).length, 3);
  assert.doesNotMatch(output, /NaN|Infinity|undefined/);
  const complete = renderMetrics({ clan, stats: { ...stats, tasks: { open: 0, claimed: 0, completed: 1 } } });
  assert.match(complete, /Completed\s+\[#{32}\]\s+1\s+100%/);
  assert.match(complete, /100% complete \/ 0 remaining/);
});

test('status fits charts to narrow terminals and neutralizes control characters', () => {
  const output = renderMetrics({ ...status, clan: { ...clan, name: '\x1b[2J\n' + 'Long clan '.repeat(10) },
    recentActivity: [{ ...status.recentActivity[0], type: 'task.completed\x1b[2J' }] }, 40);
  assert.ok(output.split('\n').every((line) => Array.from(line).length <= 40));
  assert.doesNotMatch(output, /\x1b/);
  assert.doesNotMatch(output, /ACTIVITY|task.completed|resource:/);
});

test('activity log handles empty history and neutralizes untrusted event text', () => {
  assert.equal(renderActivity([]), 'RECENT ACTIVITY / latest 10\nNo activity yet.');
  const output = renderActivity([{ ...status.recentActivity[0], type: 'task.completed\x1b[2J\n',
    resourceId: '\x1b[2J' + 'resource'.repeat(20) }], 40);
  assert.ok(output.split('\n').every((line) => Array.from(line).length <= 40));
  assert.doesNotMatch(output, /\x1b/);
  assert.match(output, /11-18 16:30Z  task.completed/);
  assert.match(output, /resource:/);
});

test('status shows only metrics and log shows only recent activity in human and JSON output', async (t) => {
  const requests = [];
  let responseValue = status;
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(responseValue));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const run = promisify(execFile);
  const call = (command, json = false) => run(process.execPath, [cli, '--api-url', `http://127.0.0.1:${server.address().port}`,
    command, '--clan', clan.id, ...(json ? ['--json'] : [])]);
  const human = await call('status');
  assert.match(human.stdout, /Example clan[\s\S]*TASKS \/ 20 total/);
  assert.doesNotMatch(human.stdout, /ACTIVITY|task.completed|resource:/);
  assert.equal(human.stderr, '');
  const json = await call('status', true);
  assert.deepEqual(JSON.parse(json.stdout), { clan, stats });
  assert.equal(json.stderr, '');
  const log = await call('log');
  assert.match(log.stdout, /RECENT ACTIVITY[\s\S]*11-18 16:30Z  task.completed/);
  assert.doesNotMatch(log.stdout, /TASKS|members|Token usage/);
  assert.equal(log.stderr, '');
  assert.deepEqual(JSON.parse((await call('log', true)).stdout), { events: status.recentActivity });
  responseValue = { ...status, recentActivity: [] };
  assert.match((await call('log')).stdout, /No activity yet/);
  assert.deepEqual(JSON.parse((await call('log', true)).stdout), { events: [] });
  assert.deepEqual(requests, Array(6).fill(`/v1/clans/${clan.id}/status`));
  await assert.rejects(call('stats'), /unknown command 'stats'/);
  assert.equal(requests.length, 6);
});

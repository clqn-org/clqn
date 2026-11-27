import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { ChatDecisionRequest, ChatMessage, ChatRouteRequest, ClqnClient } from '@clqn/shared';
import { createOrchestration } from '../src/orchestration.js';

const message = (id: string, text: string): ChatMessage => ({
  id,
  text,
  authorId: randomUUID(),
  author: 'Member',
  createdAt: '2026-11-26T12:00:00.000Z',
  replyTo: null,
  role: 'member',
  sequence: 1,
  status: 'queued',
});

test('the router forwards a follow-up while five independent sub-orchestrators are planning', async () => {
  const clanId = randomUUID();
  const leaseId = randomUUID();
  const first = message(randomUUID(), 'Build three features and fix two bugs');
  const followup = message(randomUUID(), 'For task two, keep compatibility with older clients');
  const titles = ['Feature one', 'Feature two', 'Feature three', 'Bug one', 'Bug two'];
  const work = titles.map((title, index) => ({ id: randomUUID(), title, status: 'queued', position: index + 1 }));
  const [target] = work.slice(1);
  const routes: ChatRouteRequest[] = [];
  const decisions: { id: string; decision: ChatDecisionRequest }[] = [];
  const models = new Map<string, (answer: string) => void>();
  const tasks: Promise<void>[] = [];
  const coordinator = createOrchestration(
    clanId,
    () => 0,
    () => {},
    (task) => tasks.push(task),
  );
  const api = {
    chatInbox: async (_clan: string, _lease: string, workId?: string) => {
      const item = work.find(({ id }) => id === workId);
      const next = item ? message(item.id, item.title) : routes.length ? followup : first;
      return {
        next,
        pickId: randomUUID(),
        messages: [next],
        ...(item ? { workItem: { ...item, hasTask: false } } : { work }),
      };
    },
    routeChat: async (_clan: string, _id: string, decision: ChatRouteRequest) => routes.push(decision),
    decideChat: async (_clan: string, id: string, decision: ChatDecisionRequest) => decisions.push({ id, decision }),
    listAgents: async () => ({ agents: [] }),
  } as unknown as ClqnClient;
  const host = {
    api,
    leaseId,
    active: () => true,
    generate: async (name: string, _rules: string, prompt: string) => {
      if (name === 'router') {
        if (!routes.length)
          return JSON.stringify({ action: 'start', work: titles.map((title) => ({ title, description: title })) });
        assert.match(prompt, /For task two/);
        return JSON.stringify({ action: 'followup', workId: target!.id });
      }
      return new Promise<string>((resolve) => models.set(name, resolve));
    },
  };

  coordinator.update({ pending: first.id, ready: [] }, [], host, null);
  await tasks[0];
  assert.equal(routes[0]?.action, 'start');
  const ready = work.map(({ id }) => id);
  coordinator.update({ pending: null, ready }, [], host, null);
  await new Promise((done) => setImmediate(done));
  assert.equal(models.size, 5);

  coordinator.update({ pending: followup.id, ready }, [], host, null);
  await tasks.at(-1);
  assert.equal(routes[1]?.action, 'followup');
  assert.equal(routes[1].workId, target!.id);
  assert.equal(decisions.length, 0);
  for (const finish of models.values()) finish(JSON.stringify({ action: 'reply', text: 'Planning complete' }));
  await Promise.all(tasks);
  assert.deepEqual(decisions.map(({ id }) => id).sort(), ready.sort());
});

test('losing the host lease cancels all turns before they can submit decisions', async () => {
  const clanId = randomUUID();
  const first = message(randomUUID(), 'Implement a feature');
  const tasks: Promise<void>[] = [];
  const coordinator = createOrchestration(
    clanId,
    () => 0,
    () => {},
    (task) => tasks.push(task),
  );
  let active = true;
  let modelSignal: AbortSignal | undefined;
  let finish: ((value: string) => void) | undefined;
  const host = {
    api: {
      chatInbox: async () => ({ next: first, pickId: randomUUID(), messages: [] }),
      routeChat: async () => assert.fail('A former host submitted a decision'),
    } as unknown as ClqnClient,
    leaseId: randomUUID(),
    active: () => active,
    generate: async (_name: string, _rules: string, _prompt: string, signal: AbortSignal) => {
      modelSignal = signal;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    },
  };
  coordinator.update({ pending: first.id, ready: [] }, [], host, null);
  await new Promise((done) => setImmediate(done));
  active = false;
  coordinator.stop();
  assert.equal(modelSignal?.aborted, true);
  finish?.(JSON.stringify({ action: 'reply', text: 'Acknowledged' }));
  await Promise.all(tasks);
  assert.deepEqual(coordinator.status(), []);
});

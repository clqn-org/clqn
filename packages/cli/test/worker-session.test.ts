import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { agentCommand } from '../src/agent-session.js';
import { runWorkerSession } from '../src/worker-session.js';

class Worker extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  child = this as unknown as ChildProcess;
  log = new PassThrough();
  logged = '';
  input: Record<string, unknown>[] = [];

  constructor() {
    super();
    const lines = createInterface({ input: this.stdin });
    lines.on('line', (line) => this.input.push(JSON.parse(line)));
    lines.on('close', () => this.finish(0));
    this.log.on('data', (chunk: Buffer) => {
      this.logged += chunk.toString();
    });
  }

  event(event: object) {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  finish(code: number | null) {
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('close', code));
  }

  kill() {
    this.finish(null);
    return true;
  }

  async received(index: number) {
    for (let attempt = 0; attempt < 100 && !this.input[index]; attempt++) await setTimeout(5);
    assert.ok(this.input[index], `No worker message at index ${index}`);
    return this.input[index];
  }
}

test('Claude receives updates during its turn and processes a final update before closing', async () => {
  const worker = new Worker();
  const first = { id: randomUUID(), sequence: 1, text: 'Keep the original filename' };
  const last = { id: randomUUID(), sequence: 2, text: 'Add the request ID to the result' };
  let queued: (typeof first)[] = [];
  const result = runWorkerSession({
    child: worker.child,
    runtime: 'claude',
    prompt: 'Do the approved task',
    log: worker.log,
    pollInterval: 5,
    async updates(after) {
      const messages = queued.filter(({ sequence }) => sequence > after);
      return { messages, next: messages.at(-1)?.sequence ?? after };
    },
  });

  const start = await worker.received(0);
  queued = [first];
  const followup = await worker.received(1);
  assert.equal(followup.priority, 'next');
  assert.equal(followup.uuid, first.id);
  assert.match(JSON.stringify(followup.message), /original filename/);
  queued.push(last);
  worker.event({
    type: 'result',
    result: 'First result',
    user_message_uuids: [start.uuid, first.id],
    is_error: false,
    usage: { input_tokens: 8, output_tokens: 2 },
    modelUsage: { sonnet: { inputTokens: 8, outputTokens: 2, cacheCreationInputTokens: 2 } },
  });

  const finalInput = await worker.received(2);
  assert.equal(finalInput.uuid, last.id);
  assert.match(JSON.stringify(finalInput.message), /request ID/);
  worker.event({
    type: 'result',
    result: 'Updated final result',
    user_message_uuids: [last.id],
    is_error: false,
    usage: { input_tokens: 4, output_tokens: 1 },
    modelUsage: { sonnet: { inputTokens: 12, outputTokens: 3, cacheCreationInputTokens: 2 } },
  });
  assert.deepEqual(await result, { ok: true, output: { tokens: 17, text: 'Updated final result' } });
});

test('Codex steers the active turn and retries a late follow-up in the same thread', async () => {
  const worker = new Worker();
  const update = { id: randomUUID(), sequence: 1, text: 'Cover a second test case' };
  let available = false;
  const result = runWorkerSession({
    child: worker.child,
    runtime: 'codex',
    cwd: '/project',
    commands: 'off',
    model: 'approved-model',
    prompt: 'Do the approved task',
    log: worker.log,
    pollInterval: 5,
    async updates(after) {
      return available && !after ? { messages: [update], next: 1 } : { messages: [], next: after };
    },
  });

  async function request(index: number, method: string, response: object) {
    const input = await worker.received(index);
    assert.equal(input.method, method);
    worker.event({ id: input.id, result: response });
    return input;
  }

  await request(0, 'initialize', {});
  assert.equal((await worker.received(1)).method, 'initialized');
  await request(2, 'config/read', {
    config: { mcp_servers: { local: { env: { CONFIG_SECRET: 'private-test-value' } } } },
  });
  const start = await request(3, 'thread/start', {
    thread: { id: 'thread' },
    model: 'approved-model',
    approvalPolicy: 'never',
    sandbox: { type: 'readOnly', networkAccess: false },
  });
  assert.deepEqual(start.params, {
    cwd: '/project',
    model: 'approved-model',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    config: { mcp_servers: { local: { enabled: false } } },
  });
  assert.doesNotMatch(worker.logged, /private-test-value/);
  await request(4, 'turn/start', { turn: { id: 'first' } });
  available = true;
  const steer = await worker.received(5);
  assert.equal(steer.method, 'turn/steer');
  assert.deepEqual(steer.params, {
    threadId: 'thread',
    expectedTurnId: 'first',
    clientUserMessageId: update.id,
    input: [{ type: 'text', text: (steer.params as { input: { text: string }[] }).input[0]!.text, text_elements: [] }],
  });
  assert.match(JSON.stringify(steer.params), /second test case/);

  // The first turn finished just before Codex handled the steer request.
  worker.event({
    method: 'turn/completed',
    params: { threadId: 'thread', turn: { id: 'first', status: 'completed' } },
  });
  worker.event({ id: steer.id, error: { message: 'Turn already ended' } });
  const second = await request(6, 'turn/start', { turn: { id: 'second' } });
  assert.equal((second.params as { threadId: string }).threadId, 'thread');
  assert.match(JSON.stringify(second.params), /second test case/);
  worker.event({
    method: 'thread/tokenUsage/updated',
    params: { threadId: 'thread', tokenUsage: { total: { inputTokens: 12, cachedInputTokens: 8, outputTokens: 5 } } },
  });
  worker.event({
    method: 'item/completed',
    params: { threadId: 'thread', item: { type: 'agentMessage', phase: 'final_answer', text: 'Both cases tested' } },
  });
  worker.event({
    method: 'turn/completed',
    params: { threadId: 'thread', turn: { id: 'second', status: 'completed' } },
  });
  assert.deepEqual(await result, { ok: true, output: { tokens: 9, text: 'Both cases tested' } });
});

test('isolated model commands use low effort without exposing the clqn profile', () => {
  for (const runtime of ['codex', 'claude'] as const) {
    const { args, env } = agentCommand(runtime, '/private/clqn-profile', {
      project: '/project',
      role: 'orchestrator',
      isolated: true,
    });
    assert.ok(args.includes(runtime === 'codex' ? 'model_reasoning_effort="low"' : 'low'));
    assert.ok(args.every((arg) => !arg.includes('/private/clqn-profile')));
    assert.ok(args.every((arg) => !arg.includes('mcp_servers.clqn')));
    assert.equal(env.CLQN_AGENT_PROFILE, undefined);
  }
});

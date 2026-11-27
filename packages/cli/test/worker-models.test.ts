import assert from 'node:assert/strict';
import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { discoverWorkerModels } from '../src/worker-models.js';

class Probe extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  args: string[] = [];
  requests: Record<string, unknown>[] = [];
  command?: string;

  constructor(answer: (request: Record<string, unknown>) => void = () => undefined) {
    super();
    createInterface({ input: this.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      this.requests.push(request);
      answer(request);
    });
  }

  spawn = ((command: string, args: string[]) => {
    this.command = command;
    this.args = args;
    return this as unknown as ChildProcess;
  }) as typeof spawn;

  write(event: object) {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  kill(signal: string) {
    this.signalCode = signal;
    this.stdout.end();
    queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }
}

test('discovers visible Codex launch names over a metadata-only handshake', async () => {
  const probe = new Probe(({ method, params, id }) => {
    if (method === 'initialize') {
      probe.write({ id, result: {} });
    } else if (method === 'model/list' && (params as { cursor?: string }).cursor) {
      probe.write({
        id,
        result: {
          data: [{ id: 'protocol:second', model: 'second', displayName: 'Second' }],
          nextCursor: null,
        },
      });
    } else if (method === 'model/list') {
      probe.write({
        id,
        result: {
          data: [
            { id: 'protocol:first', model: 'first', displayName: 'First\nmodel', description: 'A'.repeat(301) },
            { id: 'protocol:first-duplicate', model: 'first' },
            { id: 'protocol:hidden', model: 'hidden', hidden: true },
            { id: 'protocol:malformed', model: 'with spaces' },
            { id: 'protocol:not-a-launch-name' },
          ],
          nextCursor: 'next',
        },
      });
    }
  });
  const result = await discoverWorkerModels('codex', {
    cwd: '/metadata',
    signal: new AbortController().signal,
    spawn: probe.spawn,
  });
  assert.equal(probe.command, 'codex');
  assert.deepEqual(probe.args.slice(0, 3), ['app-server', '--listen', 'stdio://']);
  assert.deepEqual(
    probe.requests.map(({ method }) => method),
    ['initialize', 'initialized', 'model/list', 'model/list'],
  );
  assert.deepEqual(probe.requests[2]?.params, { limit: 60, includeHidden: false });
  assert.deepEqual(probe.requests[3]?.params, { limit: 59, includeHidden: false, cursor: 'next' });
  assert.deepEqual(result, [
    { id: 'first', label: 'First model', description: 'A'.repeat(300) },
    { id: 'second', label: 'Second' },
  ]);
  assert.equal(probe.signalCode, 'SIGTERM');
});

test('discovers Claude aliases and canonical names from initialize alone', async () => {
  const probe = new Probe(({ request_id }) => {
    probe.write({ type: 'control_response', response: { request_id: 'irrelevant', subtype: 'error' } });
    probe.write({
      type: 'control_response',
      response: {
        request_id,
        subtype: 'success',
        response: {
          account: { email: 'private@example.com' },
          models: [
            { value: 'sonnet', resolvedModel: 'claude-sonnet', displayName: 'Sonnet', description: 'Balanced' },
            { value: 'opus', resolvedModel: 'claude-opus', displayName: 'Opus' },
            { value: 'claude-opus', displayName: 'Opus canonical' },
            { value: '', description: 'Automatic' },
            { value: '\u001b[2J', description: 'Invalid ID' },
          ],
        },
      },
    });
  });
  const result = await discoverWorkerModels('claude', {
    cwd: '/metadata',
    signal: new AbortController().signal,
    spawn: probe.spawn,
  });
  assert.equal(probe.command, 'claude');
  assert.ok(probe.args.includes('--strict-mcp-config'));
  assert.equal(probe.args[probe.args.indexOf('--tools') + 1], '');
  assert.deepEqual(probe.requests, [
    { type: 'control_request', request_id: 'clqn-models', request: { subtype: 'initialize' } },
  ]);
  assert.deepEqual(result, [
    { id: 'sonnet', label: 'Sonnet', description: 'Balanced' },
    { id: 'opus', label: 'Opus' },
    { id: 'claude-opus', label: 'Opus canonical' },
    { id: 'claude-sonnet', label: 'Sonnet', description: 'Balanced' },
  ]);
  assert.equal(probe.signalCode, 'SIGTERM');
});

test('unsupported or aborted probes return no synthetic models', async () => {
  const controller = new AbortController();
  const unsupported = new Probe(({ id }) => unsupported.write({ id, error: { code: -32601 } }));
  assert.equal(
    await discoverWorkerModels('codex', { cwd: '/metadata', signal: controller.signal, spawn: unsupported.spawn }),
    undefined,
  );
  const pending = new Probe();
  const result = discoverWorkerModels('claude', { cwd: '/metadata', signal: controller.signal, spawn: pending.spawn });
  controller.abort();
  assert.equal(await result, undefined);
  assert.equal(pending.signalCode, 'SIGTERM');
  const alreadyAborted = new Probe();
  assert.equal(
    await discoverWorkerModels('codex', { cwd: '/metadata', signal: controller.signal, spawn: alreadyAborted.spawn }),
    undefined,
  );
  assert.equal(alreadyAborted.command, undefined);
});

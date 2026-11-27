import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { type WorkerModel, workerModelSchema } from '@clqn/shared';
import { codexDisabled, type Runtime } from './agent-session.js';

const maxModels = 60;
const timeout = 8000;
const codexArgs = ['app-server', '--listen', 'stdio://', ...codexDisabled];
const claudeArgs = [
  '--print',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--setting-sources',
  '',
  '--settings',
  '{"disableAllHooks":true}',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--tools',
  '',
];

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
function metadata(value: unknown, maxLength: number) {
  return typeof value === 'string'
    ? value
        .replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')
        .trim()
        .slice(0, maxLength)
    : '';
}

function remember(models: Map<string, WorkerModel>, value: unknown, label?: unknown, description?: unknown) {
  if (models.size >= maxModels) return;
  const name = metadata(label, 100);
  const detail = metadata(description, 300);
  const parsed = workerModelSchema.safeParse({
    id: value,
    ...(name && name !== value ? { label: name } : {}),
    ...(detail ? { description: detail } : {}),
  });
  if (parsed.success && !models.has(parsed.data.id)) models.set(parsed.data.id, parsed.data);
}

function claudeModels(rows: unknown[]) {
  const catalog = new Map<string, WorkerModel>();
  for (const row of rows) {
    const model = object(row);
    remember(catalog, model.value, model.displayName, model.description);
  }
  // Also support owners who allow a resolved ID in place of the runtime's selector alias.
  for (const row of rows) {
    const model = object(row);
    remember(catalog, model.resolvedModel, model.displayName, model.description);
  }
  return [...catalog.values()];
}

interface DiscoveryOptions {
  cwd: string;
  signal: AbortSignal;
  spawn?: typeof nodeSpawn;
}

// Ask the CLI for its picker metadata without starting a thread or sending a prompt.
export function discoverWorkerModels(
  runtime: Runtime,
  { cwd, signal, spawn = nodeSpawn }: DiscoveryOptions,
): Promise<WorkerModel[] | undefined> {
  const abort = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  if (abort.aborted) return Promise.resolve(undefined);
  const env = { ...process.env };
  delete env.CLQN_AGENT_PROFILE;
  delete env.CLQN_TOKEN;
  delete env.CLQN_CLAN_ID;
  let child: ChildProcess;
  try {
    child = spawn(runtime, runtime === 'codex' ? codexArgs : claudeArgs, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    const lines = child.stdout && createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    const catalog = new Map<string, WorkerModel>();
    const seenCursors = new Set<string>();
    let codexId = 1;
    let finished = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => finish();
    function finish(result?: WorkerModel[]) {
      if (finished) return;
      finished = true;
      abort.removeEventListener('abort', stop);
      lines?.close();
      child.stdin?.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 300).unref();
      }
      resolve(result);
    }
    const write = (frame: object) => child.stdin?.write(`${JSON.stringify(frame)}\n`);
    const claudeId = 'clqn-models';
    lines?.on('line', (line) => {
      if (finished) return;
      let event: Json;
      try {
        event = object(JSON.parse(line));
      } catch {
        return;
      }
      if (runtime === 'claude') {
        const { request_id, subtype, response } = object(event.response);
        if (event.type !== 'control_response' || request_id !== claudeId) return;
        const { models } = object(response);
        finish(subtype === 'success' && Array.isArray(models) ? claudeModels(models) : undefined);
        return;
      }
      if (event.id !== codexId || event.method) return;
      if (event.error || !event.result) return finish();
      if (codexId === 1) {
        write({ method: 'initialized' });
        write({ id: ++codexId, method: 'model/list', params: { limit: maxModels, includeHidden: false } });
        return;
      }
      const { data, nextCursor } = object(event.result);
      if (!Array.isArray(data)) return finish();
      for (const row of data) {
        const model = object(row);
        if (model.hidden !== true) remember(catalog, model.model, model.displayName, model.description);
      }
      if (catalog.size >= maxModels || typeof nextCursor !== 'string' || !nextCursor || seenCursors.has(nextCursor)) {
        finish([...catalog.values()]);
        return;
      }
      seenCursors.add(nextCursor);
      write({
        id: ++codexId,
        method: 'model/list',
        params: { limit: maxModels - catalog.size, includeHidden: false, cursor: nextCursor },
      });
    });
    child.once('error', stop);
    child.once('close', () => {
      clearTimeout(killTimer);
      finish();
    });
    child.stdin?.on('error', stop);
    abort.addEventListener('abort', stop, { once: true });
    if (abort.aborted || !lines || !child.stdin) return stop();
    if (runtime === 'codex')
      write({
        method: 'initialize',
        id: codexId,
        params: { clientInfo: { name: 'clqn', title: 'clqn', version: '1' } },
      });
    else write({ type: 'control_request', request_id: claudeId, request: { subtype: 'initialize' } });
  });
}

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

test('release installs without workspace dependencies and serves CLI and MCP', { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'clqn-package-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('dist/cli/package.json', root), 'utf8'));
  assert.equal(manifest.name, 'clqn-cli');
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.private, undefined);
  const archive = fileURLToPath(new URL(`dist/clqn-cli-${manifest.version}.tgz`, root));
  const formula = await readFile(new URL('dist/clqn.rb', root), 'utf8');
  assert.ok(formula.includes(`releases/download/v${manifest.version}/clqn-cli-${manifest.version}.tgz`));
  assert.ok(formula.includes(createHash('sha256').update(await readFile(archive)).digest('hex')));
  const npmCli = process.env.npm_execpath;
  await exec(npmCli ? process.execPath : 'npm', [...(npmCli ? [npmCli] : []), 'install', '--global', '--prefix', directory, '--cache', join(directory, 'cache'),
    '--offline', '--ignore-scripts', '--no-audit', '--no-fund', archive], { cwd: directory });
  // Windows places the npm command shim directly in the installation prefix.
  const cli = process.platform === 'win32' ? 'cmd.exe' : join(directory, 'bin', 'clqn');
  const launcher = process.platform === 'win32' ? ['/d', '/c', '.\\clqn.cmd'] : [];
  const env = { ...process.env, CLQN_CONFIG_DIR: join(directory, 'config') };
  delete env.CLQN_TOKEN;
  delete env.CLQN_CLAN_ID;
  const options = { cwd: directory, env };
  assert.equal((await exec(cli, [...launcher, '--version'], options)).stdout.trim(), manifest.version);
  assert.match((await exec(cli, [...launcher, '--help'], options)).stdout, /Your agents\. My agents\. One workspace\./);

  const health = { status: 'ok', service: 'clqn-api', version: manifest.version };
  const server = createServer((request, response) => {
    assert.equal(request.url, '/health');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(health));
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(JSON.parse((await exec(cli, [...launcher, '--api-url', apiUrl, '--json', 'health'], options)).stdout), health);

  const child = spawn(cli, [...launcher, '--api-url', apiUrl, 'mcp', '--path', '.'], {
    ...options, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const responses = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const receive = async (id) => {
    const { value, done } = await responses.next();
    assert.equal(done, false, stderr);
    const message = JSON.parse(value);
    assert.equal(message.id, id);
    assert.equal(message.error, undefined);
    return message.result;
  };
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'package-test', version: '1.0.0' } } });
  assert.equal((await receive(1)).serverInfo.name, 'clqn');
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list', params: {} });
  assert.ok((await receive(2)).tools.some((tool) => tool.name === 'clqn_health'));
  send({ id: 3, method: 'tools/call', params: { name: 'clqn_health', arguments: {} } });
  assert.deepEqual(JSON.parse((await receive(3)).content[0].text), health);
  const closed = once(child, 'close');
  child.stdin.end();
  const [code] = await closed;
  assert.equal(code, 0, stderr);
});

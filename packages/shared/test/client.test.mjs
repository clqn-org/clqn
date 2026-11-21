import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { ApiError, ClqnClient } from '../dist/index.js';

test('client refuses credential-bearing URLs and authenticated remote HTTP', () => {
  assert.throws(() => new ClqnClient('https://user:secret@example.com'), /credentials/);
  assert.throws(() => new ClqnClient('http://example.com', 'secret'), /HTTPS/);
  assert.doesNotThrow(() => new ClqnClient('https://example.com', 'secret'));
});

test('client never follows API redirects with a bearer token', async (t) => {
  let redirected = false;
  const server = createServer((request, response) => {
    if (request.url === '/v1/me') {
      assert.equal(request.headers.authorization, 'Bearer secret');
      response.writeHead(302, { location: '/destination' });
    } else {
      redirected = true;
      response.writeHead(200);
    }
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(new ClqnClient(`http://127.0.0.1:${server.address().port}`, 'secret').whoami());
  assert.equal(redirected, false);
});

test('client preserves invitation errors and validates the returned invitation', async (t) => {
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer secret');
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/invitations/join') {
      response.writeHead(404);
      response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Invitation not found' } }));
    } else {
      response.writeHead(201);
      response.end(JSON.stringify({ code: 'bad-code' }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new ClqnClient(`http://127.0.0.1:${server.address().port}`, 'secret');
  await assert.rejects(client.joinClan(`clqn_inv_${'a'.repeat(43)}`), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 404);
    assert.equal(error.code, 'NOT_FOUND');
    return true;
  });
  await assert.rejects(client.createInvitation('clan', 'bob@example.com'));
});

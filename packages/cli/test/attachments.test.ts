import assert from 'node:assert/strict';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chatAttachmentLimit } from '@clqn/shared';
import { agentCommand } from '../src/agent-session.js';
import { clipboardImage, droppedPaths, readAttachment } from '../src/attachments.js';

test('dropped files paste as paths, quoted or escaped, and other text stays text', () => {
  assert.deepEqual(droppedPaths('/Users/me/My\\ Shot.png '), ['/Users/me/My Shot.png']);
  assert.deepEqual(droppedPaths('\'/tmp/a b.PDF\' "/tmp/c.jpg"'), ['/tmp/a b.PDF', '/tmp/c.jpg']);
  assert.deepEqual(droppedPaths('file:///tmp/a%20b.webp'), ['/tmp/a b.webp']);
  assert.deepEqual(droppedPaths('~/shot.gif'), [join(homedir(), 'shot.gif')]);
  assert.deepEqual(droppedPaths('"C:\\Users\\me\\shot.png"', 'win32'), ['C:\\Users\\me\\shot.png']);
  for (const text of ['fix /tmp/a.png', '/tmp/notes.txt', 'shot.png', "'/tmp/a.png", '', '   '])
    assert.equal(droppedPaths(text), undefined, text);
});

test('attachments read images and PDFs up to the size limit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'clqn-attach-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pdf = join(directory, 'spec.pdf');
  await writeFile(pdf, 'pdf');
  assert.deepEqual(await readAttachment(pdf), {
    name: 'spec.pdf',
    type: 'application/pdf',
    data: Buffer.from('pdf').toString('base64'),
  });
  await assert.rejects(readAttachment(join(directory, 'gone.png')), /gone\.png was not found/);
  const empty = join(directory, 'empty.png');
  await writeFile(empty, '');
  await assert.rejects(readAttachment(empty), /empty/);
  const large = join(directory, 'large.png');
  await writeFile(large, '');
  await truncate(large, chatAttachmentLimit.bytes + 1);
  await assert.rejects(readAttachment(large), /over 5 MB/);
  assert.equal(await clipboardImage('win32'), undefined);
});

test('a Claude Code worker may read the attachment folder', () => {
  const attachments = { dir: '/config/attachments/task', images: ['/config/attachments/task/1-a.png'] };
  const claude = agentCommand('claude', '/profile.json', { project: '/work', role: 'worker', attachments }).args;
  assert.equal(claude[claude.lastIndexOf('--add-dir') + 1], attachments.dir);
  assert.ok(!claude.some((arg) => arg.startsWith('--image')));
});

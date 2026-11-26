import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalText } from '../src/terminal.js';

test('terminal links have an underlined, copyable URL label and piped output stays plain', (t) => {
  const terminal = process.env.TERM;
  t.after(() => {
    if (terminal === undefined) delete process.env.TERM;
    else process.env.TERM = terminal;
  });
  process.env.TERM = 'xterm';
  const url = 'https://github.com/example/project/pull/5';
  const text = `Pull request\n${url}`;
  assert.equal(terminalText(text, false), text);
  assert.equal(terminalText(text, true), `Pull request\n\x1b]8;;${url}\x1b\\\x1b[4m${url}\x1b[24m\x1b]8;;\x1b\\`);
  const credentialUrl = 'https://user:password@example.com/path';
  assert.equal(terminalText(credentialUrl, true), credentialUrl);
  process.env.TERM = 'dumb';
  assert.equal(terminalText(text, true), text);
});

test('terminal text strips injected escapes and does not link other schemes', () => {
  assert.equal(terminalText('\x1b]8;;file:///tmp/hidden\x07', true), ' ]8;;file:///tmp/hidden ');
});

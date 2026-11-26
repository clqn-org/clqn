import assert from 'node:assert/strict';
import test from 'node:test';
import { mouseReportReader, terminalText } from '../src/terminal.js';

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

test('mouse reports require a complete SGR button and coordinates', () => {
  const scrolls: number[] = [];
  const read = mouseReportReader((lines) => scrolls.push(lines));
  for (const report of ['64;10;5M', '65;10;5M', '0;10;5M', '0;10;5m']) {
    assert.equal(read(undefined, '\x1b[<'), true);
    for (const character of report) assert.equal(read(character, character), true);
  }
  assert.deepEqual(scrolls, [3, -3]);

  for (const report of ['64;1', '64;1;', '64;1;0']) {
    assert.equal(read(undefined, '\x1b[<'), true);
    for (const character of report) assert.equal(read(character, character), true);
    assert.equal(read('m', 'm'), false);
    assert.equal(read('1', '1'), false);
  }
  assert.deepEqual(scrolls, [3, -3]);
});

test('unexpected keys and idle time clear incomplete mouse reports', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const read = mouseReportReader(() => assert.fail('truncated reports cannot scroll'));
  assert.equal(read(undefined, '\x1b[<'), true);
  assert.equal(read('6', '6'), true);
  assert.equal(read(undefined, '\x1b[A'), false);
  assert.equal(read('4', '4'), false);

  assert.equal(read(undefined, '\x1b[<'), true);
  assert.equal(read('6', '6'), true);
  t.mock.timers.tick(101);
  assert.equal(read('4', '4'), false);
});

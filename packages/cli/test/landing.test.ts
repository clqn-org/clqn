import assert from 'node:assert/strict';
import test from 'node:test';
import { RELEASE_DATE, VERSION } from '@clqn/shared';
import { type LandingView, landingFrame, wordmarkLines } from '../src/landing.js';
import { width } from '../src/text.js';

const strip = (text: string) => text.replace(/\x1b\[[\d;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const view = (changes: Partial<LandingView> = {}): LandingView => ({
  columns: 110,
  rows: 34,
  color: true,
  links: true,
  user: 'ana@example.com',
  directory: '~/work/app',
  repository: 'acme/app',
  log: ['', 'Choose a clan', '  1. Create a clan', '  2. Join a clan'],
  prompt: { question: 'Enter a number: ', answer: '1' },
  ...changes,
});

test('the landing page shows the wordmark, release, links, logo, and local context beside the flow', () => {
  const frame = landingFrame(view());
  const lines = frame.lines.map(strip);
  assert.equal(frame.lines.length, 34);
  // Every row fits the terminal, so the box borders line up.
  for (const line of lines) assert.ok(width(line) <= 110, line);
  const box = lines.filter((line) => line.startsWith('  │'));
  assert.ok(box.every((line) => width(line) === 108));
  assert.match(lines[1]!, /█/);
  const title = lines.find((line) => line.includes('┌'))!;
  assert.ok(
    title.includes(`clqn v${VERSION} (${RELEASE_DATE.replaceAll('-', '.')}) · clqn.org · Documentation · GitHub · npm`),
  );
  assert.ok(frame.lines.some((line) => line.includes('\x1b]8;;https://clqn.org\x1b\\')));
  assert.ok(frame.links.some((link) => link.url === 'https://www.npmjs.com/package/clqn-cli'));
  assert.ok(lines.some((line) => /⣿/.test(line)));
  for (const detail of ['ana@example.com', '~/work/app', 'acme/app'])
    assert.ok(
      box.some((line) => line.slice(0, 40).includes(detail)),
      detail,
    );
  // The prompt sits in the right pane and the cursor follows the answer.
  const row = lines.findIndex((line) => line.includes('Enter a number: 1'));
  assert.ok(lines[row]!.indexOf('Enter a number') > 36);
  assert.deepEqual(frame.cursor, {
    row,
    column: lines[row]!.indexOf('Enter a number: 1') + 'Enter a number: 1'.length,
  });
});

test('narrow and short terminals drop the art and keep the flow', () => {
  const frame = landingFrame(
    view({ columns: 50, rows: 14, user: undefined, repository: undefined, color: false, links: false }),
  );
  assert.ok(frame.lines.every((line) => !line.includes('\x1b')));
  assert.equal(frame.lines.length, 14);
  assert.match(frame.lines[0]!, /^┌─+ clqn v\d+\.\d+\.\d+ \(.+\) · clqn\.org ─+┐$/);
  assert.ok(frame.lines.every((line) => !line.includes('█') && !line.includes('⣿')));
  assert.equal(frame.lines[1], `│ ${'Not signed in'.padEnd(46)} │`);
  // Only the newest lines stay in view.
  const long = landingFrame(view({ columns: 50, rows: 8, log: Array.from({ length: 20 }, (_, i) => `line ${i}`) }));
  const shown = long.lines.map(strip);
  assert.ok(shown.some((line) => line.includes('line 19')));
  assert.ok(!shown.some((line) => line.includes('line 0 ')));
  assert.match(shown.at(-4)!, /Enter a number: 1/);
  assert.match(shown.at(-2)!, /Esc Back/);
});

test('long questions wrap and long answers keep their end in view', () => {
  const answer = `${'a'.repeat(80)}END`;
  const frame = landingFrame(
    view({ columns: 60, rows: 20, prompt: { question: 'A rather long question that needs wrapping: ', answer } }),
  );
  const lines = frame.lines.map(strip);
  const row = lines.findIndex((line) => line.includes('END'));
  assert.equal(frame.cursor?.row, row);
  assert.ok(lines[row - 1]!.includes('wrapping:'));
  assert.ok(lines.every((line) => width(line) <= 60));
});

test('settings content replaces the log, and the first step hides Esc Back', () => {
  const frame = landingFrame(
    view({ content: (columns, rows) => [`settings ${columns}x${rows}`], prompt: undefined, log: ['hidden'] }),
  );
  const lines = frame.lines.map(strip);
  assert.ok(lines.some((line) => /settings \d+x\d+/.test(line)));
  assert.ok(!lines.some((line) => line.includes('hidden')));
  assert.equal(frame.cursor, undefined);
  const first = landingFrame(view({ prompt: { question: 'Enter a number: ', answer: '', back: false } }));
  assert.ok(first.lines.map(strip).some((line) => line.includes('Ctrl+C Quit') && !line.includes('Esc')));
  // Click targets line up with the visible link labels.
  const docs = landingFrame(view()).links.find((link) => link.url === 'https://clqn.org/docs/')!;
  assert.equal(
    strip(landingFrame(view()).lines[docs.row]!).slice(docs.column, docs.column + docs.size),
    'Documentation',
  );
});

test('the wordmark uses full blocks only, with its shadow only in color', () => {
  const plain = wordmarkLines(false);
  assert.equal(plain.length, 13);
  assert.ok(Math.max(...plain.map(width)) <= 68);
  assert.ok(plain.every((line) => /^[█ ]*$/.test(line)));
  assert.ok(wordmarkLines(true).some((line) => line.includes('38;5;95m')));
  assert.ok(wordmarkLines(true).every((line) => !line.includes('48;5;')));
});

import type { ChatMessage, ChatSettings, ChatState } from '@clqn/shared';

import { type Runtime, runtimeNames } from './agent-session.js';
import { markdownLines } from './markdown.js';
import { cells, characters, clip, type Paint, pad, painter, plain, take, width } from './text.js';

export { characters, clip, type Paint, pad, painter, plain, width };

function wrap(text: string, limit: number) {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const chars = characters(plain(paragraph));
    let start = 0;
    let used = 0;
    let space = -1;
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i]!;
      if (used + cells(char) > limit) {
        const end = space > start ? space : i;
        lines.push(chars.slice(start, end).join(''));
        start = end;
        while (chars[start] === ' ') start++;
        i = start - 1;
        used = 0;
        space = -1;
      } else {
        used += cells(char);
        if (char === ' ') space = i;
      }
    }
    lines.push(chars.slice(start).join(''));
  }
  return lines;
}

export const marginFor = (columns: number) => (columns >= 60 ? 2 : 0);
const sidebarFor = (content: number) => (content >= 72 ? Math.min(34, Math.floor(content * 0.29)) : 0);
export function transcriptColumns(columns: number) {
  const content = columns - 2 * marginFor(columns);
  const sidebar = sidebarFor(content);
  return sidebar ? content - sidebar - 3 : content;
}

export const name = (value: string) => plain(value.includes('@') ? value.split('@')[0]! : value);
export const number = (value: number) =>
  value < 1000
    ? String(value)
    : Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value).toLowerCase();
export const limit = (value: number | null) => (value === null ? '∞' : number(value));
const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const statuses = {
  queued: ['◌', 'Queued', 'muted'],
  handled: ['✓', 'Handled', 'active'],
  clarification: ['?', 'Needs clarification', 'warning'],
  approval: ['◆', 'Awaiting approval', 'warning'],
  declined: ['×', 'Declined', 'muted'],
} as const;
export const runStatuses = {
  queued: ['◌', 'Queued', 'muted'],
  running: ['◉', 'Running', 'accent'],
  done: ['✓', 'Done', 'active'],
  released: ['×', 'Released', 'muted'],
} as const;

export interface Frame {
  lines: string[];
  cursor?: { row: number; column: number };
}
interface SettingsView {
  value: ChatSettings;
  tokenText: string;
  agentText: string;
  modelText: string;
  // Agent CLIs on this machine; undefined until they are found.
  agents?: { installed: Runtime[]; off: Runtime[] } | undefined;
  // The email being typed in the leader-only Invite row; undefined hides the row.
  inviteText?: string | undefined;
  field: number;
  action: string;
}
interface View {
  columns: number;
  rows: number;
  color: boolean;
  clan: string;
  host?: string | undefined;
  userId: string;
  state?: ChatState | undefined;
  // Animation frame for the message the orchestrator is processing.
  frame?: number | undefined;
  messages: ChatMessage[];
  settings?: SettingsView | undefined;
  draft: string;
  caret: number;
  scroll: number;
  hasOlder: boolean;
  approval: number;
  approvalFocused: boolean;
  hasPullRequests?: boolean;
  reply?: ChatMessage | undefined;
  notice?: string | undefined;
}

// A bright band sweeps across muted text, like Claude Code's working status.
export function shimmer(text: string, frame: number, paint: Paint) {
  const chars = characters(text);
  const at = (frame % (chars.length + 6)) - 3;
  return chars
    .map((char, i) => {
      const distance = Math.abs(i - at);
      return paint(char, distance === 0 ? [97] : distance === 1 ? [37] : 'muted');
    })
    .join('');
}

// Puts each orchestrator or worker answer right below the message it answers, after earlier answers to it.
// Answers to messages outside the loaded history stay where they were sent.
export function threaded(messages: ChatMessage[]) {
  const ids = new Set(messages.map(({ id }) => id));
  const answers = new Map<string, ChatMessage[]>();
  const top: ChatMessage[] = [];
  for (const message of messages) {
    const parent = message.role !== 'member' && message.replyTo && ids.has(message.replyTo) ? message.replyTo : '';
    if (parent) answers.set(parent, [...(answers.get(parent) ?? []), message]);
    else top.push(message);
  }
  const ordered: ChatMessage[] = [];
  const add = (message: ChatMessage) => {
    ordered.push(message);
    for (const answer of answers.get(message.id) ?? []) add(answer);
  };
  for (const message of top) add(message);
  return ordered;
}

export function messageLines(
  message: ChatMessage,
  columns: number,
  userId: string,
  paint: Paint = (text) => text,
  frame = 0,
) {
  const isMember = message.role === 'member';
  // Messages waiting for the orchestrator shimmer, whether queued or being processed.
  const active = isMember && message.status === 'queued';
  const [icon, status, tone] = message.processing
    ? (['◌', 'Processing', 'muted'] as const)
    : isMember
      ? statuses[message.status]
      : (['›', '', 'accent'] as const);
  const author = isMember && message.authorId === userId ? 'You' : name(message.author);
  const stamp = time.format(new Date(message.createdAt));
  const label = clip(author, Math.max(1, columns - status.length - 13));
  const header =
    `${paint(icon, tone)} ${paint(label, isMember ? 'bold' : 'accent')}  ${paint(stamp, 'muted')}` +
    (status && width(label) + status.length + 11 <= columns
      ? `  ${active ? shimmer(status, frame, paint) : paint(status, tone)}`
      : '');
  const body = isMember
    ? wrap(message.text, Math.max(2, columns - 2))
    : markdownLines(message.text, Math.max(2, columns - 2), paint);
  return [header, ...body.map((line) => `  ${line}`)];
}

function compose(view: View, columns: number, paint: Paint) {
  if (!view.draft) return { line: `${paint('›', 'accent')} ${paint('Message Orchestrator', 'muted')}`, column: 2 };
  const before = characters(view.draft.slice(0, view.caret));
  let start = before.length;
  let occupied = 0;
  while (start > 0 && occupied + cells(before[start - 1]!) < columns - 3) {
    occupied += cells(before[--start]!);
  }
  const left = before.slice(start).join('');
  const text = left + view.draft.slice(view.caret);
  return { line: `${paint('›', 'accent')} ${take(text, columns - 2)}`, column: 2 + occupied };
}

function agentsText(agents: SettingsView['agents']) {
  if (!agents) return 'Checking…';
  if (!agents.installed.length) return 'None installed · install Claude Code or Codex';
  return agents.installed
    .map((runtime) => `${runtimeNames[runtime]} ${agents.off.includes(runtime) ? 'off' : 'on'}`)
    .join(' · ');
}

// Every setting row and the notice always fit; the hint, title, key help, and blank lines fill what room is left.
function settingsLines(settings: SettingsView, columns: number, paint: Paint, room: number, notice: string) {
  const labels = [
    `Spawn approval   ${settings.value.approval === 'manual' ? 'Manual' : 'Automatic'}`,
    `Token limit      ${settings.tokenText || '∞'}`,
    `Agent limit      ${settings.agentText || '∞'}`,
    `Models           ${plain(settings.modelText) || 'Any'}`,
    `Worker commands  ${{ off: 'Off', sandboxed: 'Sandboxed', unrestricted: 'Unrestricted' }[settings.value.commands]}`,
    `Agents           ${agentsText(settings.agents)}`,
    ...(settings.inviteText === undefined ? [] : [`Invite           ${plain(settings.inviteText) || 'Type an email'}`]),
    settings.action,
    'Sign out',
  ];
  const hint =
    settings.inviteText !== undefined && settings.field === 6
      ? 'Type a teammate’s email and press Enter to invite them to this clan.'
      : 'Enter a whole number or none for unlimited; models comma-separated, blank for any.';
  let spare = room - labels.length - (notice ? 1 : 0);
  const fits = (lines: number) => {
    if (spare < lines) return false;
    spare -= lines;
    return true;
  };
  const [showHint, showTitle, showKeys, showGap, showTop] = [fits(1), fits(1), fits(2), fits(1), fits(1)];
  return [
    ...(showTop ? [''] : []),
    ...(showTitle ? [paint('Session settings', 'bold')] : []),
    ...(showGap ? [''] : []),
    ...labels.map((label, index) => {
      const line = clip(`${index === settings.field ? '›' : ' '} ${label}`, columns);
      return index === settings.field ? paint(line, 'accent') : line;
    }),
    ...(showKeys ? ['', paint(clip('↑↓ Move  ←→ Change  Enter Select  Esc Back', columns), 'muted')] : []),
    ...(showHint ? [paint(clip(hint, columns), 'muted')] : []),
    ...(notice ? [notice] : []),
  ];
}

export function chatFrame(view: View): Frame {
  const columns = Math.max(1, view.columns);
  const rows = Math.max(1, view.rows);
  const paint = painter(view.color);
  if (columns < 28 || rows < 12) return { lines: [clip('Enlarge terminal · Ctrl+C to quit', columns)] };
  const margin = marginFor(columns);
  const content = columns - 2 * margin;
  const rule = paint('─'.repeat(content), 'muted');
  const header = clip(`◆ clqn / ${plain(view.clan)}`, content);
  const host = view.host ? `  ·  hosted by ${name(view.host)}` : '';
  const lines = [
    paint(header.slice(0, 6), 'accent') +
      paint(header.slice(6), 'bold') +
      paint(take(host, content - width(header)), 'muted'),
    rule,
  ];
  const finish = (cursor?: Frame['cursor']) => ({
    lines: lines.slice(0, rows).map((line) => ' '.repeat(margin) + line),
    ...(cursor && cursor.row < rows ? { cursor: { row: cursor.row, column: cursor.column + margin } } : {}),
  });
  const notice = view.notice ? paint(clip(plain(view.notice), content), 'warning') : '';
  if (view.settings) {
    lines.push(...settingsLines(view.settings, content, paint, rows - lines.length, notice));
    return finish();
  }

  const state = view.state;
  const right = sidebarFor(content);
  const left = transcriptColumns(columns);
  const heading = (label: string, span: number) =>
    paint(
      `${clip(label, span)}${'─'.repeat(Math.max(0, span - width(label) - 1)).padStart(Math.max(0, span - width(label)), ' ')}`,
      'muted',
    );
  const runLabel = `Agents · ${state?.running ?? 0} running`;
  const queued = `Orchestrator · ${state?.queued ?? 0} queued`;
  const sep = paint(' │ ', 'muted');
  lines.push(heading(queued, left) + (right ? sep + heading(runLabel, right) : ''));

  const transcript = view.messages.length
    ? view.messages.flatMap((message) => messageLines(message, left, view.userId, paint, view.frame))
    : wrap('Send a task, question, or context to the orchestrator.', left).map((line) => paint(line, 'muted'));
  const runs = state?.runs ?? [];
  const activity = right
    ? runs.flatMap((run) => {
        const [glyph, label, tone] = runStatuses[run.status];
        const repository = run.repository;
        const detail = repository?.prNumber
          ? `PR #${repository.prNumber} · ${repository.state === 'merged' ? 'Merged' : name(run.worker)}`
          : `${name(run.worker)} · ${repository ? 'Publishing' : label}`;
        const amount = run.tokens === null ? `~${number(run.estimatedTokens)}` : number(run.tokens);
        const labelWidth = Math.max(1, right - width(amount) - 1);
        return [
          `${paint(glyph, tone)}${pad(clip(` ${plain(run.title)}`, Math.max(1, labelWidth - 1)), labelWidth - 1)} ${paint(amount, 'muted')}`,
          paint(clip(`  ${detail}`, right), 'muted'),
        ];
      })
    : [];
  const pending = state?.approvals[view.approval];
  const question = view.reply ?? state?.questions[0];
  const count = state?.approvals.length ?? 0;
  const approvalKey = view.approvalFocused ? '› y/n' : '◆ Ctrl+P';
  const approvalPrefix = `${approvalKey}  Spawn · `;
  const approvalSuffix = pending
    ? `${pending.model ? ` · ${plain(pending.model)}` : ''} · ${number(pending.estimatedTokens)} est.${count > 1 ? `  (${view.approval + 1}/${count})` : ''}`
    : '';
  const attention = [
    pending
      ? paint(
          clip(
            `${approvalPrefix}${clip(plain(pending.title), Math.max(1, content - width(approvalPrefix + approvalSuffix)))}${approvalSuffix}`,
            content,
          ),
          'warning',
        )
      : '',
    question
      ? paint(clip(`${view.reply ? '› Replying' : '? Ctrl+Q Reply'}  ${plain(question.text)}`, content), 'warning')
      : '',
    notice,
  ].filter(Boolean);
  const older = view.scroll > 0 && rows >= 15;
  const transcriptRows = rows - 8 - attention.length - Number(older) - Number(!right);
  const height = Math.max(1, transcriptRows);
  const end = Math.max(0, transcript.length - view.scroll);
  const visible = transcript.slice(Math.max(0, end - height), end);
  for (let i = 0; i < height; i++) {
    const line = visible[i] ?? '';
    if (!right) {
      lines.push(line);
    } else {
      // Only the trusted styles generated here have ANSI sequences.
      const visibleWidth = width(line.replace(/\x1b\[\d+m/g, ''));
      lines.push(line + ' '.repeat(Math.max(0, left - visibleWidth)) + sep + (activity[i] ?? ''));
    }
  }
  if (older) lines.push(paint(clip('↑ Chat history · End returns to latest', content), 'muted'));
  if (!right) {
    const active = runs.find((run) => run.status === 'running') ?? runs[0];
    lines.push(
      paint(
        clip(
          `${runLabel}${active ? `  ·  ${plain(active.title)} ${active.tokens === null ? `~${number(active.estimatedTokens)}` : number(active.tokens)}` : ''}`,
          content,
        ),
        'muted',
      ),
    );
  }
  lines.push(...attention, rule);
  const composer = compose(view, content, paint);
  const composerRow = lines.length;
  lines.push(composer.line, rule);

  if (state) {
    const { settings, usage } = state;
    const filled = settings.tokenLimit
      ? Math.min(7, Math.ceil((7 * (usage.tokens + usage.reserved)) / settings.tokenLimit))
      : 0;
    const bar = paint('━'.repeat(filled) + '┄'.repeat(7 - filled), 'accent');
    const reserved = usage.reserved ? ` + ${number(usage.reserved)} est.` : '';
    const summary = `${number(usage.tokens)}/${limit(settings.tokenLimit)} tokens${reserved}  ·  ${usage.agents}/${limit(settings.agentLimit)} agents  ·  ${settings.approval === 'manual' ? 'ask' : 'auto'}`;
    lines.push(
      (content >= 52 ? `${bar}  ` : '') + paint(clip(summary, content >= 52 ? content - 9 : content), 'muted'),
    );
  } else lines.push('');
  const actions = [
    view.hasPullRequests ? 'Ctrl+L Pull requests' : '',
    'Ctrl+S Settings',
    pending ? (view.approvalFocused ? '↑↓ Choose  Y Approve  N Decline  Esc Back' : 'Ctrl+P Approvals') : '',
    question ? 'Ctrl+Q Reply' : '',
    'Ctrl+G Metrics',
    view.messages.length > 3 || view.hasOlder ? '↑↓ PgUp History' : '',
    'Ctrl+C Quit',
  ].filter(Boolean);
  lines.push(paint(clip(actions.join('  ·  '), content), 'muted'));
  return finish(view.approvalFocused ? undefined : { row: composerRow, column: composer.column });
}

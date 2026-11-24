import type { ChatMessage, ChatSettings, ChatState } from '@clqn/shared';

export const plain = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');
const segmenter = new Intl.Segmenter();
export const characters = (text: string) => Array.from(segmenter.segment(text), ({ segment }) => segment);
function cells(char: string) {
  if (/^\p{Mark}+$/u.test(char)) return 0;
  return /[\p{Extended_Pictographic}\p{Regional_Indicator}\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60\uffe0-\uffe6]/u.test(
    char,
  )
    ? 2
    : 1;
}
const width = (text: string) => characters(text).reduce((total, char) => total + cells(char), 0);
function take(text: string, limit: number) {
  let used = 0;
  let result = '';
  for (const char of characters(text)) {
    used += cells(char);
    if (used > limit) break;
    result += char;
  }
  return result;
}
const clip = (text: string, limit: number) => (width(text) <= limit ? text : `${take(text, limit - 1)}…`);
const pad = (text: string, limit: number) => text + ' '.repeat(Math.max(0, limit - width(text)));

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

const marginFor = (columns: number) => (columns >= 60 ? 2 : 0);
const sidebarFor = (content: number) => (content >= 72 ? Math.min(34, Math.floor(content * 0.29)) : 0);
export function transcriptColumns(columns: number) {
  const content = columns - 2 * marginFor(columns);
  const sidebar = sidebarFor(content);
  return sidebar ? content - sidebar - 3 : content;
}

const name = (value: string) => plain(value.includes('@') ? value.split('@')[0]! : value);
const number = (value: number) =>
  value < 1000
    ? String(value)
    : Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value).toLowerCase();
const limit = (value: number | null) => (value === null ? '∞' : number(value));
const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

type Tone = 'accent' | 'muted' | 'active' | 'warning' | 'bold' | 'error';
const codes: Record<Tone, number> = { accent: 96, muted: 90, active: 92, warning: 93, bold: 1, error: 91 };
type Paint = (text: string, tone: Tone) => string;
const painter =
  (color: boolean): Paint =>
  (text, tone) =>
    color ? `\x1b[${codes[tone]}m${text}\x1b[0m` : text;
const statuses = {
  queued: ['◌', 'Queued', 'muted'],
  handled: ['✓', 'Handled', 'active'],
  clarification: ['?', 'Needs clarification', 'warning'],
  approval: ['◆', 'Awaiting approval', 'warning'],
  declined: ['×', 'Declined', 'muted'],
} as const;
const runStatuses = {
  queued: ['◌', 'Queued', 'muted'],
  running: ['◉', 'Running', 'accent'],
  done: ['✓', 'Done', 'active'],
  released: ['×', 'Released', 'muted'],
} as const;

interface Frame {
  lines: string[];
  cursor?: { row: number; column: number };
}
interface SettingsView {
  value: ChatSettings;
  tokenText: string;
  agentText: string;
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
  messages: ChatMessage[];
  settings?: SettingsView | undefined;
  clans?: { names: string[]; selected: number } | undefined;
  draft: string;
  caret: number;
  scroll: number;
  hasOlder: boolean;
  approval: number;
  approvalFocused: boolean;
  reply?: ChatMessage | undefined;
  notice?: string | undefined;
}

export function messageLines(message: ChatMessage, columns: number, userId: string, paint: Paint = (text) => text) {
  const isMember = message.role === 'member';
  const [icon, status, tone] = isMember ? statuses[message.status] : (['›', '', 'accent'] as const);
  const author = isMember && message.authorId === userId ? 'You' : name(message.author);
  const stamp = time.format(new Date(message.createdAt));
  const label = clip(author, Math.max(1, columns - status.length - 13));
  const header =
    `${paint(icon, tone)} ${paint(label, isMember ? 'bold' : 'accent')}  ${paint(stamp, 'muted')}` +
    (status && width(label) + status.length + 11 <= columns ? `  ${paint(status, tone)}` : '');
  return [header, ...wrap(message.text, Math.max(2, columns - 2)).map((line) => `  ${line}`)];
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

function settingsLines(settings: SettingsView, columns: number, paint: Paint) {
  const labels = [
    `Spawn approval   ${settings.value.approval === 'manual' ? 'Manual' : 'Automatic'}`,
    `Token limit      ${settings.tokenText || '∞'}`,
    `Agent limit      ${settings.agentText || '∞'}`,
    settings.action,
  ];
  return [
    paint('Session settings', 'bold'),
    '',
    ...labels.map((label, index) => {
      const line = clip(`${index === settings.field ? '›' : ' '} ${label}`, columns);
      return index === settings.field ? paint(line, 'accent') : line;
    }),
    '',
    paint(clip('↑↓ Move  ←→ Approval  Enter Select  Esc Back', columns), 'muted'),
    paint(clip('Enter a whole number or none for unlimited.', columns), 'muted'),
  ];
}

function tokenTrend(hours: number[], columns: number, paint: Paint) {
  let total = 0;
  const cumulative = hours.map((tokens) => {
    total = Math.min(Number.MAX_SAFE_INTEGER, total + tokens);
    return total;
  });
  const caption = `Clan tokens · 24h  ${number(total)}`;
  const slots = Math.min(hours.length, columns - width(caption) - 2);
  if (slots < 1) return paint(clip(caption, columns), 'muted');
  const levels = '▁▂▃▄▅▆▇█';
  const trend = Array.from({ length: slots }, (_, slot) => {
    const end = Math.ceil(((slot + 1) * hours.length) / slots) - 1;
    return levels[total ? Math.round(((levels.length - 1) * cumulative[end]!) / total) : 0];
  }).join('');
  return `${paint(caption, 'muted')}  ${paint(trend, 'accent')}`;
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
  if (view.clans) {
    const offset = Math.max(0, view.clans.selected - rows + 6);
    lines.push(
      'Choose a clan',
      '',
      ...view.clans.names
        .slice(offset, offset + rows - 5)
        .map((clan, i) =>
          i + offset === view.clans!.selected
            ? paint(clip(`› ${plain(clan)}`, content), 'accent')
            : clip(`  ${plain(clan)}`, content),
        ),
    );
    lines.push(paint('↑↓ Move  Enter Open  Esc Quit', 'muted'));
    return finish();
  }
  if (view.settings) {
    lines.push('', ...settingsLines(view.settings, content, paint));
    if (notice) lines.splice(rows - 1, 0, notice);
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
    ? view.messages.flatMap((message) => messageLines(message, left, view.userId, paint))
    : wrap('Send a task, question, or context to the orchestrator.', left).map((line) => paint(line, 'muted'));
  const runs = state?.runs ?? [];
  const activity = right
    ? runs.flatMap((run) => {
        const [glyph, label, tone] = runStatuses[run.status];
        const amount = run.tokens === null ? `~${number(run.estimatedTokens)}` : number(run.tokens);
        const labelWidth = Math.max(1, right - width(amount) - 1);
        return [
          `${paint(glyph, tone)}${pad(clip(` ${plain(run.title)}`, Math.max(1, labelWidth - 1)), labelWidth - 1)} ${paint(amount, 'muted')}`,
          paint(clip(`  ${name(run.worker)} · ${label}`, right), 'muted'),
        ];
      })
    : [];
  const pending = state?.approvals[view.approval];
  const question = view.reply ?? state?.questions[0];
  const count = state?.approvals.length ?? 0;
  const approvalKey = view.approvalFocused ? '› y/n' : '◆ F3';
  const approvalPrefix = `${approvalKey}  Spawn · `;
  const approvalSuffix = pending
    ? ` · ${number(pending.estimatedTokens)} est.${count > 1 ? `  (${view.approval + 1}/${count})` : ''}`
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
      ? paint(clip(`${view.reply ? '› Replying' : '? F4 Reply'}  ${plain(question.text)}`, content), 'warning')
      : '',
    notice,
  ].filter(Boolean);
  const older = view.scroll > 0 && rows >= 15;
  const transcriptRows = rows - 8 - attention.length - Number(older) - Number(!right);
  const trend = transcriptRows > 1 ? state?.reportedTokensByHour : undefined;
  const height = Math.max(1, transcriptRows - Number(trend !== undefined));
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
  if (trend) lines.push(tokenTrend(trend, content, paint));
  const actions = [
    'F2 Settings',
    pending ? (view.approvalFocused ? '↑↓ Choose  Y Approve  N Decline  Esc Back' : 'F3 Approvals') : '',
    question ? 'F4 Reply' : '',
    view.messages.length > 3 || view.hasOlder ? 'PgUp History' : '',
    'Ctrl+C Quit',
  ].filter(Boolean);
  lines.push(paint(clip(actions.join('  ·  '), content), 'muted'));
  return finish(view.approvalFocused ? undefined : { row: composerRow, column: composer.column });
}

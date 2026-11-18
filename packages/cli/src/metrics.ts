import type { ClqnClient } from '@clqn/shared';

type Stats = Awaited<ReturnType<ClqnClient['stats']>>;
type Status = Awaited<ReturnType<ClqnClient['status']>>;

// API strings are untrusted, including clan names and activity types.
const plain = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const fit = (text: string, width: number) => {
  const chars = Array.from(plain(text));
  return chars.length <= width ? chars.join('') : `${chars.slice(0, width - 3).join('')}...`;
};

export function renderMetrics(result: Stats | Status, columns = 80): string {
  const width = Math.max(32, Math.min(100, Number.isFinite(columns) ? Math.floor(columns) : 80));
  const stats = 'stats' in result ? result.stats : result;
  const total = stats.tasks.open + stats.tasks.claimed + stats.tasks.completed;
  const percent = (count: number) => total === 0 ? 0 : Math.round(count / total * 100);
  const countWidth = String(total).length;
  const barWidth = Math.max(4, Math.min(32, width - countWidth - 22));
  const lines = [
    fit('clan' in result ? `CLAN / ${result.clan.name}` : 'CLAN / Workspace usage', width),
    '='.repeat(width),
    `${stats.members} members  /  ${stats.agents} agents`,
    '',
    `TASKS / ${total} total`,
  ];
  for (const [label, count] of [
    ['Open', stats.tasks.open], ['Claimed', stats.tasks.claimed], ['Completed', stats.tasks.completed],
  ] as const) {
    const filled = total === 0 ? 0 : Math.round(count / total * barWidth);
    lines.push(`${label.padEnd(9)} [${'#'.repeat(filled)}${'.'.repeat(barWidth - filled)}] ${String(count).padStart(countWidth)} ${String(percent(count)).padStart(3)}%`);
  }
  lines.push('', total === 0 ? 'No tasks yet.' : `${percent(stats.tasks.completed)}% complete / ${total - stats.tasks.completed} remaining`);

  if ('recentActivity' in result) {
    lines.push('', 'RECENT ACTIVITY / latest 10');
    if (result.recentActivity.length === 0) lines.push('No activity yet.');
    for (const event of result.recentActivity) {
      lines.push(fit(`${event.createdAt.slice(5, 16).replace('T', ' ')}Z  ${event.type}`, width));
      if (event.resourceId) lines.push(fit(`  resource: ${event.resourceId}`, width));
    }
  }
  lines.push('', 'Token usage / cost: not collected.');
  return lines.join('\n');
}

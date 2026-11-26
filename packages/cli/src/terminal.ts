// Keep escape sequences in API text from reaching the terminal, and make URLs clickable in a TTY.
// The full URL remains visible for copying.
export function terminalText(text: string, tty: boolean): string {
  const clean = text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ');
  if (!tty || process.env.TERM === 'dumb') return clean;
  return clean.replace(/https?:\/\/\S+/g, (url) => {
    const target = URL.parse(url);
    if (!target || target.username || target.password) return url;
    return `\x1b]8;;${target.href}\x1b\\\x1b[4m${url}\x1b[24m\x1b]8;;\x1b\\`;
  });
}

// Readline emits the SGR mouse prefix separately from the button and coordinates.
export function mouseReportReader(scroll: (lines: number) => void) {
  let pending: { report: string; at: number } | undefined;
  return (text: string | undefined, sequence: string | undefined): boolean => {
    if (sequence === '\x1b[<') {
      pending = { report: '', at: Date.now() };
      return true;
    }
    const previous = pending;
    pending = undefined;
    if (!previous || !text || Date.now() - previous.at >= 100) return false;
    const report = previous.report + text;
    if (report.length > 32) return false;
    if (/^(?:\d+;){0,2}\d*$/.test(report)) {
      pending = { report, at: Date.now() };
      return true;
    }
    const match = /^(\d+);[1-9]\d*;[1-9]\d*([Mm])$/.exec(report);
    if (!match) return false;
    if (match[2] === 'M') {
      const button = Number(match[1]);
      if (button === 64) scroll(3);
      if (button === 65) scroll(-3);
    }
    return true;
  };
}

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

import { spawn } from 'node:child_process';
import { terminalText } from './terminal.js';

function desktopCommand(command: string, args: string[], input?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'] });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
    child.unref();
    child.stdin?.on('error', () => resolve(false));
    child.stdin?.end(input);
  });
}

async function copyCode(code: string) {
  if (process.platform === 'darwin') return desktopCommand('pbcopy', [], code);
  if (process.platform === 'win32') return desktopCommand('clip.exe', [], code);
  if (process.env.WAYLAND_DISPLAY && (await desktopCommand('wl-copy', [], code))) return true;
  return (
    (await desktopCommand('xclip', ['-selection', 'clipboard'], code)) ||
    desktopCommand('xsel', ['--clipboard', '--input'], code)
  );
}

function openLink(url: string) {
  if (process.platform === 'darwin') return desktopCommand('open', [url]);
  if (process.platform === 'win32') return desktopCommand('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
  return desktopCommand('xdg-open', [url]);
}

export function showGithubLogin(verificationUri: string, userCode: string): () => void {
  const { stdin, stderr } = process;
  const heading = 'Open GitHub to authorize clqn:';
  const codeLabel = 'Enter this one-time GitHub code:';
  if (!stdin.isTTY || !stderr.isTTY || process.env.TERM === 'dumb' || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode)) {
    console.error(terminalText(`${heading}\n${verificationUri}\n\n${codeLabel} ${userCode}`, stderr.isTTY));
    return () => undefined;
  }

  const button = '[Copy code]';
  const copyLine = `${userCode}  ${button}`;
  const link = terminalText(verificationUri, true);
  const wasRaw = stdin.isRaw;
  const wasFlowing = stdin.readableFlowing;
  let active = true;
  let mouse = false;
  let status = '';
  let input = '';

  function draw() {
    if (!active) return;
    const fits = stderr.columns >= Math.max(verificationUri.length, codeLabel.length) && stderr.rows >= 7;
    if (mouse !== fits) {
      stderr.write(fits ? '\x1b[?1006h\x1b[?1000h' : '\x1b[?1000l\x1b[?1006l');
      mouse = fits;
    }
    const action = fits ? `  \x1b[4m${button}\x1b[24m` : '';
    stderr.write(`\x1b[2J\x1b[H${heading}\r\n${link}\r\n\r\n${codeLabel}\r\n${userCode}${action}\r\n\r\n${status}`);
  }

  function read(chunk: Buffer | string) {
    if (chunk.includes('\x03') || chunk.includes('\x04')) return interrupt();
    input += chunk.toString();
    for (const [, column, row] of input.matchAll(/\x1b\[<0;(\d+);(\d+)M/g)) {
      if (!mouse) continue;
      if (row === '5' && Number(column) <= copyLine.length) {
        void copyCode(userCode).then((copied) => {
          status = copied ? 'Code copied.' : 'Clipboard unavailable.';
          draw();
        });
      }
      // Some terminals send link clicks as mouse reports while mouse tracking is active.
      if (row === '2' && Number(column) <= verificationUri.length) {
        void openLink(verificationUri).then((opened) => {
          if (opened) return;
          status = 'Could not open GitHub.';
          draw();
        });
      }
    }
    // A mouse report can be split across reads. Keep only the unfinished suffix.
    input = input.slice(-32).match(/\x1b(?:\[<?[\d;]*)?$/)?.[0] ?? '';
  }

  function stop() {
    if (!active) return;
    active = false;
    stdin.off('data', read);
    stderr.off('resize', draw);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    stdin.setRawMode(wasRaw);
    if (!wasFlowing) stdin.pause();
    stderr.write('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l');
  }

  function exit(code: number) {
    stop();
    stderr.write('', () => process.exit(code));
  }
  const interrupt = () => exit(130);
  const terminate = () => exit(143);

  stdin.setRawMode(true);
  stdin.on('data', read);
  stderr.on('resize', draw);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  stderr.write('\x1b[?1049h\x1b[?25l');
  draw();
  stdin.resume();
  return stop;
}

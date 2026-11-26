import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ChatAttachmentInput, chatAttachmentLimit } from '@clqn/shared';

const types: Record<string, ChatAttachmentInput['type']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};
const megabytes = chatAttachmentLimit.bytes / 1024 / 1024;
const tooLarge = (name: string) => new Error(`${name} is over ${megabytes} MB`);

// Terminals paste a dropped file as its path: quoted or with escaped spaces, several separated by spaces.
// Returns the paths only when every one is an image or PDF, so other pasted text stays text.
export function droppedPaths(text: string, platform = process.platform): string[] | undefined {
  const words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= '';
    } else if (char === '\\' && platform !== 'win32' && index + 1 < text.length) {
      word = (word ?? '') + text[++index];
    } else if (/\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? '') + char;
  }
  if (quote) return undefined;
  if (word !== undefined) words.push(word);
  const paths = words.map((path) => {
    if (path.startsWith('file://')) {
      try {
        return fileURLToPath(path);
      } catch {
        return '';
      }
    }
    return path.startsWith('~/') ? homedir() + path.slice(1) : path;
  });
  const absolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
  if (!paths.length || !paths.every((path) => absolute(path) && types[extname(path).toLowerCase()])) return undefined;
  return paths;
}

export async function readAttachment(path: string): Promise<ChatAttachmentInput> {
  const name = basename(path);
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`${name} was not found`);
  if (info.size > chatAttachmentLimit.bytes) throw tooLarge(name);
  const data = await readFile(path);
  if (!data.length) throw new Error(`${name} is empty`);
  return { name, type: types[extname(path).toLowerCase()]!, data: data.toString('base64') };
}

function output(command: string, args: string[]): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: 'buffer', maxBuffer: chatAttachmentLimit.bytes * 3, timeout: 5000 },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}

// The image on the system clipboard as a PNG, or undefined when it holds none.
export async function clipboardImage(platform = process.platform): Promise<ChatAttachmentInput | undefined> {
  let data: Buffer | undefined;
  if (platform === 'darwin') {
    // AppleScript prints the image as «data PNGf89504E47…».
    const text = (await output('osascript', ['-e', 'the clipboard as «class PNGf»']))?.toString('utf8');
    const hex = text?.match(/«data PNGf([0-9A-Fa-f]+)»/)?.[1];
    data = hex ? Buffer.from(hex, 'hex') : undefined;
  } else if (platform === 'linux') {
    data =
      (process.env.WAYLAND_DISPLAY ? await output('wl-paste', ['--no-newline', '--type', 'image/png']) : undefined) ??
      (await output('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']));
  }
  // PNG files start with \x89PNG.
  if (!data || data.length < 8 || data.readUInt32BE(0) !== 0x89504e47) return undefined;
  if (data.length > chatAttachmentLimit.bytes) throw tooLarge('The clipboard image');
  return { name: 'clipboard.png', type: 'image/png', data: data.toString('base64') };
}

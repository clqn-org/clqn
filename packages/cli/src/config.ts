import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  token?: string;
  clanId?: string;
}

const directory = () => process.env.CLQN_CONFIG_DIR ?? join(homedir(), '.config', 'clqn');
const filename = (apiUrl: string) =>
  join(directory(), `${createHash('sha256').update(new URL(apiUrl).origin).digest('hex')}.json`);

export async function readConfig(apiUrl: string): Promise<Config> {
  let contents: string;
  try {
    contents = await readFile(filename(apiUrl), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Could not read clqn configuration');
  }
  try {
    const config: unknown = JSON.parse(contents);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
    const value = config as Record<string, unknown>;
    if (
      (value.token !== undefined && typeof value.token !== 'string') ||
      (value.clanId !== undefined && typeof value.clanId !== 'string')
    )
      throw new Error();
    return {
      ...(typeof value.token === 'string' ? { token: value.token } : {}),
      ...(typeof value.clanId === 'string' ? { clanId: value.clanId } : {}),
    };
  } catch {
    throw new Error('Invalid clqn configuration; log out to remove it');
  }
}

export async function writeConfig(apiUrl: string, config: Config): Promise<void> {
  await mkdir(directory(), { recursive: true, mode: 0o700 });
  await chmod(directory(), 0o700);
  const path = filename(apiUrl);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeConfig(apiUrl: string): Promise<void> {
  await rm(filename(apiUrl), { force: true });
}

import { spawn } from 'node:child_process';
import { repositorySlugSchema } from '@clqn/shared';

const failure = () =>
  new Error('GitHub webhook operation failed. Check gh authentication and repository admin access.');

// Pass secrets on stdin, never in process arguments or surfaced GitHub error output.
async function ghApi(args: string[], body?: unknown): Promise<unknown> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn('gh', ['api', '--hostname', 'github.com', ...args], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(failure());
    }, 120_000);
    let contents = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      contents += chunk;
      if (Buffer.byteLength(contents) > 2 * 1024 * 1024) {
        child.kill('SIGTERM');
        reject(failure());
      }
    });
    child.stdin.on('error', () => {
      /* The close/error handler reports a sanitized failure. */
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        error.code === 'ENOENT'
          ? new Error('gh is required; install GitHub CLI and authenticate before linking a repository')
          : failure(),
      );
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(contents);
      else reject(failure());
    });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
  if (!output.trim()) return null;
  try {
    return JSON.parse(output);
  } catch {
    throw failure();
  }
}

function hookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Provide a valid clqn webhook URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/hooks\/github\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(url.pathname)
  ) {
    throw new Error('Use the clqn HTTPS webhook URL without credentials, query parameters, or fragments');
  }
  return url.href;
}

async function findHook(repository: string, url: string): Promise<number | undefined> {
  const pages = await ghApi([`repos/${repository}/hooks`, '--paginate', '--slurp']);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw failure();
  const matches = pages.flat().filter((item: unknown) => {
    if (!item || typeof item !== 'object') throw failure();
    return (item as { config?: { url?: string } }).config?.url === url;
  });
  if (matches.length > 1)
    throw new Error('More than one GitHub webhook matches this clan link; remove duplicate hooks before retrying');
  if (!matches.length) return undefined;
  const id = (matches[0] as { id?: number }).id;
  if (!Number.isSafeInteger(id) || id! <= 0) throw failure();
  return id;
}

export async function configureGithubWebhook(input: { repository: string; url: string; secret: string }) {
  const repository = repositorySlugSchema.parse(input.repository);
  const url = hookUrl(input.url);
  if (typeof input.secret !== 'string' || input.secret.length < 32)
    throw new Error('Webhook secret must have at least 32 characters');
  const existing = await findHook(repository, url);
  const body = {
    ...(existing === undefined ? { name: 'web' } : {}),
    active: true,
    events: ['push'],
    config: { url, content_type: 'json', secret: input.secret, insecure_ssl: '0' },
  };
  const response = (await ghApi(
    [
      `repos/${repository}/hooks${existing === undefined ? '' : `/${existing}`}`,
      '--method',
      existing === undefined ? 'POST' : 'PATCH',
      '--input',
      '-',
    ],
    body,
  )) as { id?: number; config?: { url?: string } } | null;
  if (
    !response ||
    !Number.isSafeInteger(response.id) ||
    response.id! <= 0 ||
    (existing !== undefined && response.id !== existing) ||
    (response.config?.url !== undefined && response.config.url !== url)
  )
    throw failure();
  return { id: response.id!, url };
}

export async function removeGithubWebhook(input: { repository: string; url: string }) {
  const repository = repositorySlugSchema.parse(input.repository);
  const url = hookUrl(input.url);
  const id = await findHook(repository, url);
  if (id === undefined) return { removed: false };
  await ghApi([`repos/${repository}/hooks/${id}`, '--method', 'DELETE']);
  return { removed: true };
}

import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, ClqnClient } from '@clqn/shared';
import { hostedServer } from './config.js';
import { showGithubLogin } from './login-prompt.js';

export async function githubLogin(server: string) {
  const api = new ClqnClient(server);
  const attempt = await api.startGithubLogin().catch((error: unknown) => {
    if (error instanceof TypeError || (error as Error).name === 'TimeoutError') {
      const destination = server === hostedServer ? 'hosted clqn' : `clqn at ${server}`;
      throw new Error(`Could not reach ${destination}. Check your connection and try again.`);
    }
    if (error instanceof ApiError && error.status === 503 && error.code === 'UNAVAILABLE')
      throw new ApiError(
        error.status,
        error.code,
        'GitHub sign-in is unavailable on this server. Ask your server operator to enable it or provide a personal credential.',
      );
    throw error;
  });
  const stop = showGithubLogin(attempt.verificationUri, attempt.userCode);
  try {
    return await waitForGithubLogin(api, attempt);
  } finally {
    stop();
  }
}

async function waitForGithubLogin(api: ClqnClient, attempt: Awaited<ReturnType<ClqnClient['startGithubLogin']>>) {
  const deadline = Date.now() + attempt.expiresIn * 1000;
  let interval = attempt.interval;
  while (Date.now() + interval * 1000 < deadline) {
    await delay(interval * 1000);
    let result: Awaited<ReturnType<ClqnClient['pollGithubLogin']>>;
    try {
      result = await api.pollGithubLogin(attempt.handle);
    } catch (error) {
      // Retry rate limits, server errors, and network failures until the code expires.
      if (
        error instanceof ApiError
          ? error.status === 429 || error.status >= 500
          : error instanceof TypeError || (error as Error).name === 'TimeoutError'
      )
        continue;
      throw error;
    }
    if (result.status === 'pending') {
      interval = result.interval;
      continue;
    }
    if (result.status !== 'complete')
      throw new Error(`GitHub login ${result.status}. Start again or contact the operator for account conflicts.`);
    return result;
  }
  throw new Error('GitHub sign-in expired. Run clqn to try again.');
}

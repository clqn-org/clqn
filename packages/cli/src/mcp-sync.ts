import type { ClqnClient } from '@clqn/shared';
import { localRepository } from './git.js';
import { runSyncWatch, type SyncWatchOptions } from './sync-watch.js';

// One MCP connection follows its own local project, without scanning or storing paths.
export async function runMcpSync(
  api: ClqnClient,
  clanId: string,
  options: Omit<SyncWatchOptions, 'repository' | 'getEvents' | 'sync' | 'initialCursor'>,
): Promise<void> {
  try {
    if (options.signal.aborted) return;
    const { root, repository } = await localRepository(options.repoPath, options.signal);
    if (options.signal.aborted) return;
    let initialCursor = 0;
    try {
      // Read the watermark before fetching, so a push during startup is not missed.
      const links = await api.repositories(clanId, options.signal);
      initialCursor = links.repositories.find((link) => link.slug === repository)?.lastEventSequence ?? 0;
    } catch (error) {
      if (options.signal.aborted) return;
      options.onError(error);
    }
    await runSyncWatch({
      ...options,
      repoPath: root,
      repository,
      initialCursor,
      getEvents: (cursor, signal) => api.events(clanId, cursor, 100, signal),
    });
  } catch (error) {
    if (!options.signal.aborted) options.onError(error);
  }
}

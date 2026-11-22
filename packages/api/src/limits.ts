import { ApiError } from '@clqn/shared';

// Caps that keep one account or clan from growing storage without bound.
export const limits = {
  clansPerUser: 25,
  agentsPerMember: 25,
  contextEntriesPerClan: 500,
  contextRevisionsKept: 100,
};

export const limitReached = (message: string) => new ApiError(409, 'LIMIT_REACHED', message);

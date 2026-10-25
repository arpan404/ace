/** The lease owner name of one agent in one thread. */
export function agentOwner(threadId: string, agentId: string): string {
  return JSON.stringify([threadId, agentId]);
}

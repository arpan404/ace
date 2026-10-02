/** Shared command routing key; provider IDs remain opaque and are never filesystem paths. */
export function nativeAgentKey(threadId: string, sessionId: string): string {
  return `${threadId}:acp:agent:${JSON.stringify(sessionId)}`;
}

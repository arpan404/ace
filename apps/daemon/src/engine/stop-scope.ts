/*
 * What a Stop (`thread.interrupt`) reaches, decided once for every part of ace that acts on it:
 * the handler's queue hold, the delivery's shell stop and close fallback, and agent control's
 * cancellation cascade. Naming the root agent's own id is the same as naming no agent.
 */

/** The Stop is about the thread's root agent: no agent named, or the root's own id. */
export function targetsRoot(
  p: { agentId?: string | undefined },
  rootAgentId: string | undefined,
): boolean {
  return p.agentId === undefined || p.agentId === rootAgentId;
}

/** A Stop of the whole thread: it cascades and targets the root, so everything under it stops. */
export function stopsWholeThread(
  p: { cascade: boolean; agentId?: string | undefined },
  rootAgentId: string | undefined,
): boolean {
  return p.cascade && targetsRoot(p, rootAgentId);
}

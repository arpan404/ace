/**
 * Each agent's current tab: the last tab it opened or selected. Commands without a `tabId` go
 * there. Agents without an id (older callers) share one cursor. Pure bookkeeping.
 */
export class AgentCursors {
  private cursors = new Map<string, string>();
  private static key(agentId: string | undefined): string {
    return agentId ?? "";
  }
  get(agentId: string | undefined): string | undefined {
    return this.cursors.get(AgentCursors.key(agentId));
  }
  set(agentId: string | undefined, tabId: string): void {
    this.cursors.set(AgentCursors.key(agentId), tabId);
  }
  /** Whether another identified agent's cursor points at this tab. */
  heldByOther(agentId: string | undefined, tabId: string): boolean {
    const own = AgentCursors.key(agentId);
    for (const [agent, cursor] of this.cursors)
      if (agent !== own && agent !== "" && cursor === tabId) return true;
    return false;
  }
  /** A closed tab leaves no cursor behind. */
  forget(tabId: string): void {
    for (const [agent, cursor] of this.cursors) if (cursor === tabId) this.cursors.delete(agent);
  }
  clear(): void {
    this.cursors.clear();
  }
}

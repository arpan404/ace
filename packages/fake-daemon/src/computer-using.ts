/** Which threads' agents use Mac apps now (`computer.using`), set by tests and scenarios. */
export class FakeComputerUsing {
  private readonly using = new Map<string, readonly string[]>();
  private readonly listeners = new Set<() => void>();

  /** The thread's agent uses these apps now; none clears it. */
  use(threadId: string, apps: readonly string[]): void {
    if (apps.length) this.using.set(threadId, apps);
    else this.using.delete(threadId);
    for (const listener of this.listeners) listener();
  }

  threads(): { threadId: string; apps: readonly string[] }[] {
    return [...this.using].map(([threadId, apps]) => ({ threadId, apps }));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}

/** Inject one owner across session, account and snapshot hosts to bound native/helper concurrency. */
export class CursorHostSlots {
  private live = 0;
  private capacity: number;
  private owners = new Map<() => Promise<void>, string>();
  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 64)
      throw new Error("Invalid SDK host capacity");
    this.capacity = capacity;
  }
  /** Metadata/lifetime index only; provider-kit remains the process supervisor. */
  track(instanceId: string, stop: () => Promise<void>): () => void {
    if (this.owners.size >= this.capacity)
      throw new Error("Cursor SDK host owner capacity reached");
    this.owners.set(stop, instanceId);
    return () => {
      this.owners.delete(stop);
    };
  }
  async stopInstance(instanceId: string): Promise<void> {
    const results = await Promise.allSettled(
      [...this.owners].filter(([, id]) => id === instanceId).map(([stop]) => stop()),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new Error("SDK host did not confirm exit; retain writer reservations");
  }
  acquire(): () => void {
    if (this.live >= this.capacity) throw new Error("Cursor SDK host capacity reached");
    this.live++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.live--;
      }
    };
  }
}

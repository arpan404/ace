/** Inject one owner across session, account and snapshot hosts to bound native/helper concurrency. */
export class CursorHostSlots {
  private live = 0;
  private capacity: number;
  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 64)
      throw new Error("Invalid SDK host capacity");
    this.capacity = capacity;
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

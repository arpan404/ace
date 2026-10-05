/** Reservations cover tabs being initialized and release exactly once. */
export class TabBudget {
  private count = 0;
  private limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  reserve(): () => void {
    if (this.count >= this.limit) throw new Error("Daemon browser tab limit");
    this.count++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.count--;
      }
    };
  }
}

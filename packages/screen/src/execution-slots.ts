/** Bounded host work; shared input resources have a separate ordered lane. */
export class ExecutionSlots {
  private active = 0;
  private pending = 0;
  private readonly waiting: (() => void)[] = [];
  private sharedTail: Promise<void> = Promise.resolve();
  run<T>(authorize: () => void, dispatch: () => Promise<T>): Promise<T> {
    if (this.pending >= 160) return Promise.reject(new Error("Host execution queue limit"));
    this.pending++;
    const ready =
      this.active < 8
        ? (this.active++, Promise.resolve())
        : new Promise<void>((resolve) => this.waiting.push(resolve));
    return ready
      .then(() => {
        authorize();
        return dispatch();
      })
      .finally(() => {
        this.pending--;
        const next = this.waiting.shift();
        if (next) next();
        else this.active--;
      });
  }
  shared<T>(authorize: () => void, dispatch: () => Promise<T>): Promise<T> {
    if (this.pending >= 160) return Promise.reject(new Error("Host execution queue limit"));
    // Admission is reserved before entering the shared lane too.
    this.pending++;
    const task = this.sharedTail.then(() => {
      this.pending--;
      return this.run(authorize, dispatch);
    });
    this.sharedTail = task.then(
      () => {},
      () => {},
    );
    return task;
  }
}

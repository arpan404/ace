/** Serialize a complete remote intent, including reconciliation and receipt cleanup.
 * An active writer keeps ownership until its result has settled. Independent keys proceed. */
export class ForgeIntents {
  #tails = new Map<string, Promise<void>>();
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => {}, () => {});
    this.#tails.set(key, settled);
    void settled.then(() => {
      if (this.#tails.get(key) === settled) this.#tails.delete(key);
    });
    return result;
  }
}

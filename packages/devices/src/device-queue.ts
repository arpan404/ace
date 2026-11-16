type Entry = {
  tail: Promise<void>;
  generation: number;
  running: { superseded: boolean } | undefined;
};

/**
 * One connection's subscribes and unsubscribes of each device, strictly one at a time, so a
 * subscribe's setup and rollback only ever meet the committed state. The latest wins: a new
 * operation tells the one running that it is superseded (it ends and rolls back before the next
 * starts), and a subscribe still waiting its turn when a newer operation comes is dropped
 * without running. Unsubscribes always run.
 */
export class DeviceQueue {
  readonly #devices = new Map<string, Entry>();

  run<T>(
    device: string,
    kind: "subscribe" | "unsubscribe",
    task: (superseded: () => boolean) => Promise<T>,
  ): Promise<T> {
    let entry = this.#devices.get(device);
    if (!entry) {
      entry = { tail: Promise.resolve(), generation: 0, running: undefined };
      this.#devices.set(device, entry);
    }
    const held = entry;
    const generation = ++held.generation;
    if (held.running) held.running.superseded = true;
    const ticket = { superseded: false };
    const result = held.tail.then(async () => {
      if (kind === "subscribe" && held.generation !== generation)
        throw new Error("Device subscription superseded");
      held.running = ticket;
      try {
        return await task(() => ticket.superseded);
      } finally {
        if (held.running === ticket) held.running = undefined;
      }
    });
    held.tail = result.then(
      () => {},
      () => {},
    );
    void held.tail.then(() => {
      if (held.generation === generation && this.#devices.get(device) === held)
        this.#devices.delete(device);
    });
    return result;
  }
}

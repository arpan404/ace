export interface TemporaryAccessChange {
  current(): boolean;
  complete: Promise<void>;
  rollback(): Promise<void>;
}
type Entry = { change: TemporaryAccessChange; users: Set<object> };

/** Shared temporary access is promoted by success, and undone only by its last owner. */
export class TemporaryScreenAccess {
  private readonly entries = new Map<string, Entry>();
  begin() {
    const user = {};
    const held = new Map<string, Entry>();
    return {
      acquire: async (key: string, create: () => TemporaryAccessChange | undefined) => {
        let entry = this.entries.get(key);
        if (!entry?.change.current()) {
          const change = create();
          if (!change) return;
          entry = { change, users: new Set() };
          this.entries.set(key, entry);
        }
        entry.users.add(user);
        held.set(key, entry);
        await entry.change.complete;
      },
      commit: () => {
        for (const [key, entry] of held) {
          entry.users.delete(user);
          if (this.entries.get(key) === entry) this.entries.delete(key);
        }
        held.clear();
      },
      rollback: async () => {
        const entries = [...held].toReversed();
        held.clear();
        const errors: unknown[] = [];
        // Keep later changes reserved across awaited cleanup so new users can retain them.
        for (const [key, entry] of entries) {
          entry.users.delete(user);
          if (entry.users.size || this.entries.get(key) !== entry) continue;
          this.entries.delete(key);
          if (!entry.change.current()) continue;
          try {
            await entry.change.rollback();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length)
          throw new AggregateError(errors, "Temporary screen access cleanup failed");
      },
    };
  }
}

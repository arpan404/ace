type Slot = { active: boolean; release?: () => void };

/**
 * One subscription per device (streams, logs) on a connection, at most four. A new one is
 * staged: the device's current one keeps going until the new one attaches (then it is
 * released), so a resubscribe that fails leaves it as it was. A later stage of the same device
 * supersedes an earlier one still being set up.
 */
export class DeviceSubscriptions {
  private readonly slots = new Map<string, Slot>();
  private readonly staged = new Map<string, Slot>();
  reserve(id: string) {
    const held = new Set([...this.slots.keys(), ...this.staged.keys()]);
    if (!held.has(id) && held.size >= 4) throw new Error("Device subscription limit");
    const earlier = this.staged.get(id);
    if (earlier) earlier.active = false;
    const slot: Slot = { active: true };
    this.staged.set(id, slot);
    const unstage = () => {
      if (this.staged.get(id) === slot) this.staged.delete(id);
    };
    return {
      active: () => slot.active,
      /** Set up: this subscription replaces the device's current one. */
      attach: (release: () => void) => {
        unstage();
        if (!slot.active) return release();
        const old = this.slots.get(id);
        if (old) {
          old.active = false;
          old.release?.();
        }
        slot.release = release;
        this.slots.set(id, slot);
      },
      /** Setup failed: the device's current subscription stays. */
      cancel: () => {
        unstage();
        slot.active = false;
      },
    };
  }
  remove(id: string): void {
    const staged = this.staged.get(id);
    if (staged) {
      staged.active = false;
      this.staged.delete(id);
    }
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.active = false;
    this.slots.delete(id);
    slot.release?.();
  }
  close(): void {
    for (const id of new Set([...this.slots.keys(), ...this.staged.keys()])) this.remove(id);
  }
}

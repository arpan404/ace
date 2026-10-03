/** Reserve ownership before async setup; superseded completions are immediately released. */
export class DeviceSubscriptions {
  private readonly slots = new Map<string, { active: boolean; release?: () => void }>();
  reserve(id: string) {
    this.remove(id);
    if (this.slots.size >= 4) throw new Error("Device subscription limit");
    const slot: { active: boolean; release?: () => void } = { active: true };
    this.slots.set(id, slot);
    return {
      active: () => slot.active,
      attach: (release: () => void) => {
        if (!slot.active) release();
        else slot.release = release;
      },
      cancel: () => {
        if (this.slots.get(id) === slot) this.remove(id);
      },
    };
  }
  remove(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.active = false;
    this.slots.delete(id);
    slot.release?.();
  }
  close(): void {
    for (const id of this.slots.keys()) this.remove(id);
  }
}

/** Indexed min-heap: one entry per live deadline, with no stale tombstones. */
export class Deadlines {
  private entries: { key: string; at: number }[] = [];
  private positions = new Map<string, number>();
  get next(): number | undefined {
    return this.entries[0]?.at;
  }
  get first(): string | undefined {
    return this.entries[0]?.key;
  }
  set(key: string, at: number): void {
    this.delete(key);
    const index = this.entries.length;
    this.entries.push({ key, at });
    this.positions.set(key, index);
    this.up(index);
  }
  delete(key: string): void {
    const index = this.positions.get(key);
    if (index === undefined) return;
    const last = this.entries.pop();
    this.positions.delete(key);
    if (!last || index === this.entries.length) return;
    this.entries[index] = last;
    this.positions.set(last.key, index);
    this.down(this.up(index));
  }
  private swap(a: number, b: number): void {
    const left = this.entries[a];
    const right = this.entries[b];
    if (!left || !right) return;
    this.entries[a] = right;
    this.entries[b] = left;
    this.positions.set(right.key, a);
    this.positions.set(left.key, b);
  }
  private up(index: number): number {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const current = this.entries[index];
      const above = this.entries[parent];
      if (!current || !above || current.at >= above.at) break;
      this.swap(index, parent);
      index = parent;
    }
    return index;
  }
  private down(index: number): void {
    for (;;) {
      let child = index * 2 + 1;
      const left = this.entries[child];
      if (!left) return;
      const right = this.entries[child + 1];
      if (right && right.at < left.at) child++;
      const current = this.entries[index];
      const below = this.entries[child];
      if (!current || !below || current.at <= below.at) return;
      this.swap(index, child);
      index = child;
    }
  }
}

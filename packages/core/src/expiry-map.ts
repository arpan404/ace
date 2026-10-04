interface Entry<T> {
  key: string;
  value: T;
  expiresAt: number;
}

/** Indexed min-heap: expiry visits only due entries, deletion retains no tombstones. */
export class ExpiryMap<T> {
  private heap: Entry<T>[] = [];
  private indexes = new Map<string, number>();
  first(): Readonly<Entry<T>> | undefined {
    return this.heap[0];
  }
  clear(): void {
    this.heap = [];
    this.indexes.clear();
  }
  get size(): number {
    return this.heap.length;
  }
  deadline(key: string): number | undefined {
    const index = this.indexes.get(key);
    return index === undefined ? undefined : this.at(index).expiresAt;
  }
  get(key: string): T | undefined {
    const index = this.indexes.get(key);
    return index === undefined ? undefined : this.at(index).value;
  }
  set(key: string, value: T, expiresAt: number): void {
    this.delete(key);
    const index = this.heap.length;
    this.heap.push({ key, value, expiresAt });
    this.indexes.set(key, index);
    this.up(index);
  }
  delete(key: string): T | undefined {
    const index = this.indexes.get(key);
    return index === undefined ? undefined : this.remove(index).value;
  }
  *expire(now: number): Generator<{ key: string; value: T }> {
    while (this.heap.length && this.at(0).expiresAt <= now) yield this.remove(0);
  }
  private at(index: number): Entry<T> {
    const entry = this.heap[index];
    if (!entry) throw new Error("Invalid expiry heap index");
    return entry;
  }
  private swap(left: number, right: number): void {
    const first = this.at(left);
    const second = this.at(right);
    this.heap[left] = second;
    this.heap[right] = first;
    this.indexes.set(first.key, right);
    this.indexes.set(second.key, left);
  }
  private up(start: number): number {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.at(parent).expiresAt <= this.at(index).expiresAt) break;
      this.swap(parent, index);
      index = parent;
    }
    return index;
  }
  private down(start: number): void {
    let index = start;
    while (index * 2 + 1 < this.heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.heap.length && this.at(child + 1).expiresAt < this.at(child).expiresAt)
        child++;
      if (this.at(index).expiresAt <= this.at(child).expiresAt) break;
      this.swap(index, child);
      index = child;
    }
  }
  private remove(index: number): Entry<T> {
    const removed = this.at(index);
    const last = this.heap.pop();
    this.indexes.delete(removed.key);
    if (last && index < this.heap.length) {
      this.heap[index] = last;
      this.indexes.set(last.key, index);
      this.down(this.up(index));
    }
    return removed;
  }
}

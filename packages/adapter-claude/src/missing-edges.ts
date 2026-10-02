interface Edge {
  id: string;
  at: number;
}
/** Indexed min-heap: reads are constant time, updates and expirations logarithmic. */
export class MissingEdges {
  #heap: Edge[] = [];
  #positions = new Map<string, number>();
  nextDeadline(): number | undefined {
    return this.#heap[0]?.at;
  }
  set(id: string, at: number): void {
    const existing = this.#positions.get(id);
    if (existing !== undefined) {
      const edge = this.#heap[existing];
      if (!edge) return;
      edge.at = at;
      this.#repair(existing);
    } else {
      const index = this.#heap.length;
      this.#heap.push({ id, at });
      this.#positions.set(id, index);
      this.#up(index);
    }
  }
  delete(id: string): void {
    const index = this.#positions.get(id);
    if (index === undefined) return;
    this.#positions.delete(id);
    const last = this.#heap.pop();
    if (!last || index === this.#heap.length) return;
    this.#heap[index] = last;
    this.#positions.set(last.id, index);
    this.#repair(index);
  }
  expired(now: number): string[] {
    const ids: string[] = [];
    let edge = this.#heap[0];
    while (edge && edge.at <= now) {
      ids.push(edge.id);
      this.delete(edge.id);
      edge = this.#heap[0];
    }
    return ids;
  }
  clear(): void {
    this.#heap = [];
    this.#positions.clear();
  }
  #repair(index: number): void {
    const parent = Math.floor((index - 1) / 2);
    if (index > 0 && (this.#heap[index]?.at ?? Infinity) < (this.#heap[parent]?.at ?? Infinity))
      this.#up(index);
    else this.#down(index);
  }
  #up(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if ((this.#heap[parent]?.at ?? Infinity) <= (this.#heap[index]?.at ?? Infinity)) return;
      this.#swap(index, parent);
      index = parent;
    }
  }
  #down(index: number): void {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      const smallest =
        (this.#heap[right]?.at ?? Infinity) < (this.#heap[left]?.at ?? Infinity) ? right : left;
      if ((this.#heap[index]?.at ?? Infinity) <= (this.#heap[smallest]?.at ?? Infinity)) return;
      this.#swap(index, smallest);
      index = smallest;
    }
  }
  #swap(first: number, second: number): void {
    const a = this.#heap[first];
    const b = this.#heap[second];
    if (!a || !b) return;
    this.#heap[first] = b;
    this.#heap[second] = a;
    this.#positions.set(a.id, second);
    this.#positions.set(b.id, first);
  }
}

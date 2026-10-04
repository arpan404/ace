import { applyDelta } from "@ace/projection";
import { Item, type DeliveryEvent, type ItemsPage } from "@ace/protocol";
import { ClientError, type Limits } from "./types.ts";
interface Change {
  seq: number;
  payload: Extract<
    DeliveryEvent["payload"],
    { type: "item.updated" | "item.delta" | "item.deleted" }
  >;
  size: number;
}
/** Bounded ring: eviction is O(1), independent of accumulated Map tombstones. */
export class PageJournal {
  private changes: (Change | undefined)[] = [];
  private head = 0;
  private count = 0;
  private bytes = 0;
  private floor = 0;
  private limits: Limits;
  constructor(limits: Limits) {
    this.limits = limits;
  }
  reset(seq: number): void {
    this.changes = [];
    this.head = 0;
    this.count = 0;
    this.bytes = 0;
    this.floor = seq;
  }
  record(event: DeliveryEvent): void {
    const payload = event.payload;
    if (
      payload.type !== "item.updated" &&
      payload.type !== "item.delta" &&
      payload.type !== "item.deleted"
    )
      return;
    const size =
      payload.type === "item.delta"
        ? payload.append.length * 2 + 128
        : JSON.stringify(payload).length * 2;
    while (
      this.count &&
      (this.count === this.limits.entities || this.bytes + size > this.limits.frameBytes)
    ) {
      const first = this.changes[this.head];
      if (first) {
        this.bytes -= first.size;
        this.floor = first.seq;
      }
      this.changes[this.head] = undefined;
      this.head = (this.head + 1) % this.limits.entities;
      this.count--;
    }
    if (size > this.limits.frameBytes) {
      this.floor = event.seq;
      return;
    }
    this.changes[(this.head + this.count) % this.limits.entities] = {
      seq: event.seq,
      payload,
      size,
    };
    this.count++;
    this.bytes += size;
  }
  reconcile(page: ItemsPage, cursor: number): Item[] {
    if (page.seq < this.floor && page.seq < cursor)
      throw new ClientError("stale", "History page needs a fresh read");
    const items = new Map(page.items.map((item) => [item.id, Item.parse(item)]));
    for (let i = 0; i < this.count; i++) {
      const change = this.changes[(this.head + i) % this.limits.entities];
      if (!change || change.seq <= page.seq) continue;
      const p = change.payload;
      if (p.type === "item.updated" && items.has(p.item.id))
        items.set(p.item.id, Item.parse(p.item));
      if (p.type === "item.deleted") items.delete(p.itemId);
      if (p.type === "item.delta") {
        const item = items.get(p.itemId);
        if (item) applyDelta(item, p.field, p.append);
      }
    }
    return [...items.values()];
  }
}

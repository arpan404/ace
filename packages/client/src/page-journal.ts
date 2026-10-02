import { applyDelta } from "@ace/projection";
import { Item, type DeliveryEvent, type ItemsPage } from "@ace/protocol";
import { ClientError, type Limits } from "./types.ts";
/** Bounded change journal reconciles pages read before live delivery. */
export class PageJournal {
  private events = new Map<number, { event: DeliveryEvent; size: number }>();
  private bytes = 0;
  private floor = 0;
  private limits: Limits;
  constructor(limits: Limits) {
    this.limits = limits;
  }
  reset(seq: number): void {
    this.events.clear();
    this.bytes = 0;
    this.floor = seq;
  }
  record(event: DeliveryEvent): void {
    if (event.payload.type !== "item.updated" && event.payload.type !== "item.delta") return;
    const size =
      event.payload.type === "item.delta"
        ? event.payload.append.length * 2 + 128
        : JSON.stringify(event.payload).length * 2;
    this.events.set(event.seq, { event, size });
    this.bytes += size;
    while (this.events.size > this.limits.entities || this.bytes > this.limits.frameBytes) {
      const first = this.events.entries().next().value;
      if (!first) break;
      this.events.delete(first[0]);
      this.bytes -= first[1].size;
      this.floor = first[0];
    }
  }
  reconcile(page: ItemsPage, cursor: number): Item[] {
    if (page.seq < this.floor && page.seq < cursor)
      throw new ClientError("stale", "History page needs a fresh read");
    const items = new Map(page.items.map((item) => [item.id, Item.parse(item)]));
    for (const { event } of this.events.values()) {
      if (event.seq <= page.seq) continue;
      const p = event.payload;
      if (p.type === "item.updated" && items.has(p.item.id))
        items.set(p.item.id, Item.parse(p.item));
      if (p.type === "item.delta") {
        const item = items.get(p.itemId);
        if (item) applyDelta(item, p.field, p.append);
      }
    }
    return [...items.values()];
  }
}

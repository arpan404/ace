import { RecentMap } from "./cache.ts";
import { eventSession } from "./boundaries.ts";
import { object, string } from "./data.ts";
import type { ServerConsumer } from "./server.ts";
/** Cache positive ownership only; every hit still checks current location/ancestry. */
export class Routes {
  private owners = new RecentMap<ServerConsumer[]>(4096);
  clear(): void {
    this.owners.clear();
  }
  select(data: unknown, watermark: number, consumers: Iterable<ServerConsumer>): ServerConsumer[] {
    const e = object(data),
      p = object(e.data);
    const session = eventSession(data);
    const key = session || (string(e.type).startsWith("shell.") ? `shell:${string(p.id)}` : "");
    const cached = this.owners.get(key);
    const accepted = (cached ?? [...consumers]).filter((c) => c.accepts(data, watermark));
    if (cached && !accepted.length) {
      this.owners.delete(key);
      return this.select(data, watermark, consumers);
    }
    if (key && accepted.length) this.owners.set(key, accepted);
    const shell =
      e.type === "shell.created"
        ? string(object(p.info).id)
        : string(e.type).startsWith("session.tool.")
          ? string(object(p.metadata).shellID)
          : "";
    if (shell && accepted.length) this.owners.set(`shell:${shell}`, accepted);
    return accepted;
  }
}

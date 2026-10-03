import { ClientError } from "@ace/client";
import { z } from "zod";

/** One ordered transition stream per tab/thread. Pending reservations count toward admission. */
export class BrowserSubscriptions {
  private entries = new Map<string, { held: boolean; pending: number; tail: Promise<void> }>();
  private pending = 0;
  private closed = false;
  run(
    thread: string,
    type: "browser.subscribe" | "browser.unsubscribe",
    request: () => Promise<unknown>,
    cleanup: () => void,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new ClientError("offline"));
    if (this.pending >= 32) return Promise.reject(new ClientError("limit"));
    let entry = this.entries.get(thread);
    if (!entry) {
      if (this.entries.size >= 8) return Promise.reject(new ClientError("limit"));
      entry = { held: false, pending: 0, tail: Promise.resolve() };
      this.entries.set(thread, entry);
    }
    const owned = entry;
    owned.pending++;
    this.pending++;
    const result = owned.tail.then(async () => {
      if (this.closed) throw new ClientError("offline");
      let value: unknown;
      try {
        value = await request();
      } catch (error) {
        // A timed-out response can follow server admission. Release that subscriber explicitly.
        if (type === "browser.subscribe" && !owned.held) cleanup();
        throw error;
      }
      if (z.object({ ok: z.literal(true) }).safeParse(value).success)
        owned.held = type === "browser.subscribe";
      return value;
    });
    owned.tail = result
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        owned.pending--;
        this.pending--;
        if (this.closed) cleanup();
        else if (!owned.pending && !owned.held) this.entries.delete(thread);
      });
    return result;
  }
  close(cleanup: (thread: string) => void): void {
    this.closed = true;
    for (const thread of this.entries.keys()) cleanup(thread);
  }
}

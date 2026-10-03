import type { OpenCodeClient } from "@opencode/client";
import { NativeEvent, SessionInfo, eventSession } from "./boundaries.ts";
import type { SessionOwnership } from "./ownership.ts";
import { string } from "./data.ts";
type Ports = {
  client: OpenCodeClient;
  ownership: SessionOwnership;
  directory(): string;
  info(value: unknown): void;
  receive(value: unknown): void;
};
/** Unknown facts are bounded evidence until a GET chain proves ownership. */
export class AncestryProbe {
  private p: Ports;
  private unknown = new Map<string, unknown[]>();
  private unknownBytes = 0;
  private unknownFailures = new Set<string>();
  constructor(p: Ports) {
    this.p = p;
  }
  prove(data: unknown): void {
    const e = NativeEvent.safeParse(data);
    if (!e.success || !e.data.location) return;
    const id = eventSession(data);
    if (
      !id ||
      this.p.ownership.sessions.has(id) ||
      this.unknownFailures.has(id) ||
      e.data.location.directory !== this.p.directory() ||
      e.data.type === "session.created"
    )
      return;
    const queued = this.unknown.get(id);
    const bytes = Buffer.byteLength(JSON.stringify(data));
    if (
      this.unknownBytes + bytes > 1024 * 1024 ||
      (queued?.length ?? 0) >= 32 ||
      (!queued && this.unknown.size >= 8)
    )
      return;
    this.unknownBytes += bytes;
    if (queued) {
      queued.push(data);
      return;
    }
    this.unknown.set(id, [data]);
    void (async () => {
      try {
        const chain = [],
          visited = new Set<string>();
        let cursor = id;
        while (!this.p.ownership.sessions.has(cursor)) {
          if (chain.length >= 16 || visited.has(cursor))
            throw new Error("Unverified OpenCode ancestry");
          visited.add(cursor);
          const info = SessionInfo.parse(await this.p.client.session.get({ sessionID: cursor }));
          if (info.fork || !info.parentID || info.id !== cursor)
            throw new Error("Unowned OpenCode root/fork");
          chain.push(info);
          cursor = info.parentID;
        }
        for (const info of chain.toReversed()) {
          this.p.ownership.admit(info, string(info.parentID));
          this.p.info(info);
        }
        for (const event of this.unknown.get(id) ?? []) this.p.receive(event);
      } catch {
        this.unknownFailures.add(id);
        if (this.unknownFailures.size > 128) {
          const first = this.unknownFailures.values().next().value;
          if (first) this.unknownFailures.delete(first);
        }
      } finally {
        for (const event of this.unknown.get(id) ?? [])
          this.unknownBytes -= Buffer.byteLength(JSON.stringify(event));
        this.unknown.delete(id);
      }
    })();
  }
}

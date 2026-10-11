import type { OpenCodeClient } from "@opencode/client";
import { NativeEvent, SessionInfo, eventSession } from "./boundaries.ts";
import type { SessionOwnership } from "./ownership.ts";
import { string } from "./data.ts";
type Ports = {
  client: OpenCodeClient;
  ownership: SessionOwnership;
  directory(): string;
  info(value: unknown): void;
  receive(value: unknown, watermark: number): void;
  buffered(value: unknown, watermark: number): void;
  pending(id: string, value: unknown): void;
  settled(id: string): void;
  failed(value: unknown): void;
  recovering(): boolean;
};
type Probe = {
  guard: string;
  events: { data: unknown; watermark: number }[];
  needsRecovery: boolean;
  lookupFailed: boolean;
};
/** Unknown facts are bounded evidence until a GET chain proves ownership. */
export class AncestryProbe {
  private p: Ports;
  private probes = new Map<string, Probe>();
  private unknownBytes = 0;
  private sequence = 0;
  constructor(p: Ports) {
    this.p = p;
  }
  prove(data: unknown, watermark: number): void {
    const e = NativeEvent.safeParse(data);
    if (!e.success || !e.data.location) return;
    const id = eventSession(data);
    if (
      !id ||
      this.p.ownership.sessions.has(id) ||
      e.data.location.directory !== this.p.directory() ||
      e.data.type === "session.created"
    )
      return;
    const queued = this.probes.get(id);
    const bytes = Buffer.byteLength(JSON.stringify(data));
    if (
      this.unknownBytes + bytes > 1024 * 1024 ||
      (queued?.events.length ?? 0) >= 32 ||
      (!queued && this.probes.size >= 8)
    ) {
      this.p.failed(data);
      return;
    }
    this.unknownBytes += bytes;
    this.p.buffered(data, watermark);
    if (queued) {
      queued.events.push({ data, watermark });
      return;
    }
    const guard = `ancestry:${++this.sequence}`;
    const probe: Probe = {
      guard,
      events: [{ data, watermark }],
      needsRecovery: this.p.recovering(),
      lookupFailed: false,
    };
    this.probes.set(id, probe);
    this.p.pending(guard, data);
    void (async () => {
      try {
        const chain = [],
          visited = new Set<string>();
        let cursor = id;
        while (!this.p.ownership.sessions.has(cursor)) {
          if (chain.length >= 16 || visited.has(cursor))
            throw new Error("Unverified OpenCode ancestry");
          visited.add(cursor);
          const value = await this.p.client.session.get({ sessionID: cursor });
          if (this.probes.get(id) !== probe) return;
          if (probe.needsRecovery && this.p.ownership.sessions.has(id)) {
            if (!this.p.recovering()) this.p.failed(data);
            return;
          }
          const info = SessionInfo.parse(value);
          if (info.id !== cursor) throw new Error("Mismatched OpenCode ancestry identity");
          if (info.fork || !info.parentID) {
            this.finish(id, probe);
            return;
          }
          chain.push(info);
          cursor = info.parentID;
        }
        for (const info of chain.toReversed()) {
          this.p.ownership.admit(info, string(info.parentID));
          this.p.info(info);
        }
        if (probe.needsRecovery || this.p.recovering()) {
          probe.needsRecovery = true;
          this.p.failed(data);
          return;
        }
        for (const event of probe.events) this.p.receive(event.data, event.watermark);
      } catch {
        if (this.probes.get(id) !== probe) return;
        probe.needsRecovery = true;
        probe.lookupFailed = true;
        this.p.failed(data);
      } finally {
        if (!probe.needsRecovery) this.finish(id, probe);
      }
    })();
  }
  observePending(observe: (data: unknown, watermark: number) => void): void {
    for (const probe of this.probes.values()) {
      probe.needsRecovery = true;
      for (const event of probe.events) observe(event.data, event.watermark);
    }
  }
  needsSnapshots(complete: (id: string) => boolean): boolean {
    for (const id of this.probes.keys())
      if (this.p.ownership.sessions.has(id) && !complete(id)) return true;
    return false;
  }
  reconciled(): void {
    for (const [id, probe] of this.probes) {
      const owned = this.p.ownership.sessions.has(id);
      if (!owned && !probe.lookupFailed) continue;
      if (owned) for (const event of probe.events) this.p.receive(event.data, event.watermark);
      this.finish(id, probe);
    }
  }
  private finish(id: string, probe: Probe): void {
    if (this.probes.get(id) !== probe) return;
    for (const event of probe.events)
      this.unknownBytes -= Buffer.byteLength(JSON.stringify(event.data));
    this.probes.delete(id);
    this.p.settled(probe.guard);
  }
}

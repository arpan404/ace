import { PresenceUpdate } from "@ace/protocol/notifications";
import type { DeviceId, ThreadId } from "@ace/protocol";

type Presence = { device: DeviceId; thread: ThreadId | null; receivedAt: number; inputAt: number };
/** Indexed by focused thread; disconnect and replacement remove old index entries. */
export class PresenceIndex {
  private sessions = new Map<string, Presence>();
  private threads = new Map<ThreadId, Map<string, Presence>>();
  private limit: number;
  constructor(limit = 256) {
    this.limit = limit;
  }
  update(session: string, device: DeviceId, input: unknown, now: number): void {
    const value = PresenceUpdate.parse(input);
    if (!this.sessions.has(session) && this.sessions.size >= this.limit)
      throw new Error("Presence capacity reached");
    this.remove(session);
    const presence = {
      device,
      thread: value.threadId,
      receivedAt: now,
      inputAt: now - value.inputAgeMs,
    };
    this.sessions.set(session, presence);
    if (value.threadId) {
      let viewers = this.threads.get(value.threadId);
      if (!viewers) {
        viewers = new Map();
        this.threads.set(value.threadId, viewers);
      }
      viewers.set(session, presence);
    }
  }
  remove(session: string): void {
    const previous = this.sessions.get(session);
    if (previous?.thread) {
      const viewers = this.threads.get(previous.thread);
      viewers?.delete(session);
      if (viewers?.size === 0) this.threads.delete(previous.thread);
    }
    this.sessions.delete(session);
  }
  revoke(device: DeviceId): void {
    for (const [session, value] of this.sessions) if (value.device === device) this.remove(session);
  }
  viewedElsewhere(thread: ThreadId, device: DeviceId, now: number): boolean {
    const viewers = this.threads.get(thread);
    if (!viewers) return false;
    for (const value of viewers.values()) {
      if (
        value.device !== device &&
        now - value.receivedAt <= 60_000 &&
        now - value.inputAt <= 120_000
      )
        return true;
    }
    return false;
  }
}

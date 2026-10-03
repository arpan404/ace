import { z } from "zod";
import { coveredPrefix } from "./text-coverage.ts";
import { NativeEvent } from "./boundaries.ts";
import { array, object, string, number } from "./data.ts";

type Snapshot = { channel: string; data: unknown; session: string; started: number };
/** Bounded evidence for one recovery epoch. Text and absence have separate clocks. */
export class RecoveryEvidence {
  private snapshots: Snapshot[] = [];
  private bytes = 0;
  private deltas = new Map<
    string,
    { chunks: { text: string; watermark: number }[]; covered: number }
  >();
  private deltaBytes = 0;
  private work = new Map<string, number>();
  private interactions = new Map<string, number>();
  private inbox = new Map<string, number>();
  private key(type: string, session: string, message: string, ordinal: number): string {
    return `${type}:${session}:${message}:${ordinal}`;
  }
  reset(): void {
    this.snapshots = [];
    this.bytes = this.deltaBytes = 0;
    this.deltas.clear();
    this.work.clear();
    this.interactions.clear();
    this.inbox.clear();
  }
  pass(): void {
    this.snapshots = [];
    this.bytes = 0;
  }
  observe(value: unknown, watermark: number): void {
    const e = NativeEvent.parse(value),
      p = e.data,
      session = string(p.sessionID);
    if (e.type === "session.text.delta" || e.type === "session.reasoning.delta") {
      const key = this.key(
        e.type.includes("reasoning") ? "reasoning" : "text",
        session,
        string(p.assistantMessageID),
        number(p.ordinal),
      );
      const entry = this.deltas.get(key) ?? { chunks: [], covered: 0 };
      this.deltaBytes += Buffer.byteLength(string(p.delta));
      if (
        (this.deltas.size >= 4096 && !this.deltas.has(key)) ||
        this.deltaBytes > 8 * 1024 * 1024 ||
        entry.chunks.length >= 4096
      )
        throw new Error("OpenCode recovery text budget");
      entry.chunks.push({ text: string(p.delta), watermark });
      this.deltas.set(key, entry);
    } else if (e.type.startsWith("permission.") || e.type.startsWith("form.")) {
      this.interactions.set(string(object(p.form).sessionID, session), watermark);
    } else if (e.type.startsWith("session.inbox.")) {
      this.inbox.set(session, watermark);
      this.work.set(session, watermark);
    } else if (
      e.type.startsWith("session.execution.") ||
      e.type.startsWith("session.tool.") ||
      e.type === "session.synthetic"
    ) {
      this.work.set(session, watermark);
    }
  }
  message(data: unknown): void {
    const p = object(data),
      message = object(p.message),
      session = string(p.sessionID);
    if (message.type !== "assistant") return;
    array(message.content).forEach((value, ordinal) => {
      const block = object(value);
      if (block.type !== "text" && block.type !== "reasoning") return;
      const entry = this.deltas.get(
        this.key(string(block.type), session, string(message.id), ordinal),
      );
      // Only a matching suffix establishes coverage. Arrival time alone cannot prove
      // a concurrent HTTP response includes a delta received on the SSE connection.
      if (!entry) return;
      const matched = coveredPrefix(
        string(block.text),
        entry.chunks.map((chunk) => chunk.text).join(""),
      );
      let length = 0;
      entry.covered = 0;
      for (const chunk of entry.chunks) {
        length += chunk.text.length;
        if (length > matched) {
          if (matched > length - chunk.text.length)
            throw new Error("OpenCode partial delta coverage is uncertain");
          break;
        }
        entry.covered = chunk.watermark;
      }
    });
  }
  covered(value: unknown, watermark: number): boolean {
    const e = NativeEvent.parse(value),
      p = e.data;
    if (e.type !== "session.text.delta" && e.type !== "session.reasoning.delta") return false;
    const key = this.key(
      e.type.includes("reasoning") ? "reasoning" : "text",
      string(p.sessionID),
      string(p.assistantMessageID),
      number(p.ordinal),
    );
    return watermark <= (this.deltas.get(key)?.covered ?? 0);
  }
  stage(channel: string, data: unknown, session: string, started: number): void {
    this.bytes += Buffer.byteLength(JSON.stringify(data));
    if (this.bytes > 8 * 1024 * 1024 || this.snapshots.length >= 4096)
      throw new Error("OpenCode snapshot budget exceeded");
    this.snapshots.push({ channel, data, session, started });
  }
  positive(): Snapshot[] {
    const positive: Snapshot[] = [],
      remaining: Snapshot[] = [];
    for (const snap of this.snapshots)
      (snap.channel === "snapshot.active" && object(snap.data).running === true
        ? positive
        : remaining
      ).push(snap);
    this.snapshots = remaining;
    return positive;
  }
  finish(): Snapshot[] {
    return this.snapshots.splice(0).filter((s) => {
      const clock =
        s.channel === "snapshot.interactions"
          ? this.interactions
          : s.channel === "snapshot.inbox"
            ? this.inbox
            : this.work;
      return (clock.get(s.session) ?? 0) <= s.started;
    });
  }
  interactionKeys(data: unknown): Set<string> {
    return new Set(z.array(z.string()).parse(object(data).keys));
  }
}

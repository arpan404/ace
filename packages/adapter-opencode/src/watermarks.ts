import { RecentMap } from "./cache.ts";
import { object, string } from "./data.ts";
import { toolStatus } from "./tools.ts";
function key(data: unknown): string {
  const payload = object(object(data).payload);
  const type = string(payload.type);
  const p = object(payload.properties);
  if (type.startsWith("permission.")) return "permission";
  if (type.startsWith("question.")) return "question";
  const id =
    type === "message.part.updated"
      ? string(object(p.part).id)
      : string(p.sessionID, string(object(p.info).id));
  return `${type}:${id}`;
}
type Snapshot = { started: number; received: number };
function preservesWork(data: unknown): boolean {
  const payload = object(object(data).payload);
  const p = object(payload.properties);
  if (payload.type === "session.status")
    return ["busy", "retry"].includes(string(object(p.status).type));
  if (payload.type === "message.part.updated") {
    const part = object(p.part);
    return (
      part.type === "tool" && ["pending", "running"].includes(toolStatus(object(part.state), false))
    );
  }
  return ["permission.asked", "question.asked", "session.created"].includes(string(payload.type));
}
/** REST has no event cursor. During an in-flight snapshot, retain live work but
 * defer ambiguous terminal evidence until a subsequent live update/snapshot. */
export class SnapshotWatermarks {
  private recent = new RecentMap<Snapshot>(1024);
  private statuses = new Map<string, Snapshot>();
  private live = new Map<string, number>();
  private deferred = new Map<string, { data: unknown; started: number }>();
  observe(data: unknown, watermark: number): void {
    const id = key(data);
    if (preservesWork(data)) this.live.set(id, watermark);
    else this.live.delete(id);
  }
  allowsSnapshot(data: unknown, started: number): boolean {
    return preservesWork(data) || (this.live.get(key(data)) ?? -1) <= started;
  }
  category(name: string, started: number, received: number): void {
    this.recent.set(name, { started, received });
  }
  record(data: unknown, started: number, received: number): void {
    const id = key(data);
    const snapshot = { started, received };
    if (id.startsWith("session.status:")) this.statuses.set(id, snapshot);
    else this.recent.set(id, snapshot);
  }
  stage(data: unknown, started: number, received: number): boolean {
    this.record(data, started, received);
    const id = key(data);
    this.deferred.delete(id);
    const payload = object(object(data).payload);
    if (
      payload.type === "session.status" &&
      object(object(payload.properties).status).type === "idle"
    ) {
      this.deferred.set(id, { data, started });
      return false;
    }
    return this.allowsSnapshot(data, started);
  }
  flush(): unknown[] {
    const frames: unknown[] = [];
    for (const { data, started } of this.deferred.values())
      if (this.allowsSnapshot(data, started)) frames.push(data);
    this.deferred.clear();
    this.live.clear();
    return frames;
  }
  covers(data: unknown, watermark: number): boolean {
    const id = key(data);
    const snapshot = id.startsWith("session.status:") ? this.statuses.get(id) : this.recent.get(id);
    if (!snapshot) return false;
    return watermark <= (preservesWork(data) ? snapshot.started : snapshot.received);
  }
}

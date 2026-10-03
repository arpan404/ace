import { RecentMap } from "./cache.ts";
import { object, string } from "./data.ts";
function key(data: unknown): string {
  const payload = object(object(data).payload);
  const type = string(payload.type);
  const p = object(payload.properties);
  if (type.startsWith("permission.")) return `permission:${string(p.id, string(p.requestID))}`;
  if (type.startsWith("question.")) return `question:${string(p.id, string(p.requestID))}`;
  const id =
    type === "message.part.updated"
      ? string(object(p.part).id)
      : string(p.sessionID, string(object(p.info).id));
  return `${type}:${id}`;
}
type Snapshot = { started: number };
/** REST has no event cursor. Events observed after a request began remain
 * authoritative in both directions. Idle snapshots settle only after those
 * events have registered surviving tools, including events from earlier passes. */
export class SnapshotWatermarks {
  private recent = new RecentMap<Snapshot>(1024);
  private statuses = new Map<string, Snapshot>();
  private observed = new Map<string, number>();
  private deferred = new Map<string, { data: unknown; started: number }>();
  observe(data: unknown, watermark: number): void {
    this.observed.set(key(data), watermark);
  }
  isLatest(data: unknown, watermark: number): boolean {
    return this.observed.get(key(data)) === watermark;
  }
  allowsSnapshot(data: unknown, started: number): boolean {
    return (this.observed.get(key(data)) ?? -1) <= started;
  }
  category(name: string, started: number): void {
    this.recent.set(name, { started });
  }
  record(data: unknown, started: number): void {
    const id = key(data);
    const snapshot = { started };
    if (id.startsWith("session.status:")) this.statuses.set(id, snapshot);
    else this.recent.set(id, snapshot);
  }
  stage(data: unknown, started: number): boolean {
    this.record(data, started);
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
    this.observed.clear();
    return frames;
  }
  covers(data: unknown, watermark: number): boolean {
    const id = key(data);
    const snapshot = id.startsWith("session.status:")
      ? this.statuses.get(id)
      : (this.recent.get(id) ?? this.recent.get(id.split(":")[0] ?? ""));
    if (!snapshot) return false;
    return watermark <= snapshot.started;
  }
}

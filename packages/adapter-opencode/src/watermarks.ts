import { RecentMap } from "./cache.ts";
import { object, string } from "./data.ts";
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
/** Receipt ordinals prevent older buffered updates from overwriting REST evidence. */
export class SnapshotWatermarks {
  private recent = new RecentMap<number>(1024);
  private statuses = new Map<string, number>();
  category(name: string, watermark: number): void {
    this.recent.set(name, watermark);
  }
  record(data: unknown, watermark: number): void {
    const id = key(data);
    if (id.startsWith("session.status:")) this.statuses.set(id, watermark);
    else this.recent.set(id, watermark);
  }
  covers(data: unknown, watermark: number): boolean {
    const id = key(data);
    const through = id.startsWith("session.status:") ? this.statuses.get(id) : this.recent.get(id);
    return watermark <= (through ?? -1);
  }
}

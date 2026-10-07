import { z } from "zod";

const TraceEvent = z.looseObject({
  name: z.string(),
  ts: z.number().finite().optional(),
  dur: z.number().finite().optional(),
  pid: z.number().int().optional(),
  tid: z.number().int().optional(),
  args: z
    .looseObject({
      data: z.record(z.string(), z.unknown()).optional(),
      message: z.string().optional(),
      layerTreeId: z.number().int().optional(),
    })
    .optional(),
});
const Batch = z.object({ value: z.array(z.unknown()), aceTruncated: z.boolean().optional() });
type Event = z.infer<typeof TraceEvent>;
/** Discard irrelevant trace payloads immediately; no trace or video is retained. */
export class MeasurementTrace {
  private events: Event[] = [];
  private marker: Event | undefined;
  private layerTrees = new Map<string, string>();
  private maxEvents = 7500;
  truncated = false;
  constructor(privateLabel: string) {
    this.label = privateLabel;
  }
  private label: string;
  accept(raw: unknown): void {
    const batch = Batch.safeParse(raw);
    if (!batch.success) {
      this.truncated = true;
      return;
    }
    if (batch.data.aceTruncated) this.truncated = true;
    for (const rawEvent of batch.data.value) {
      const parsed = TraceEvent.safeParse(rawEvent);
      if (!parsed.success) continue;
      const event = parsed.data;
      if (event.name === "SetLayerTreeId") {
        const frame = event.args?.data?.["frame"],
          tree = event.args?.data?.["layerTreeId"];
        if (typeof frame === "string" && typeof tree === "number") {
          const key = `${event.pid}:${tree}`;
          if (this.layerTrees.size < 64 || this.layerTrees.has(key))
            this.layerTrees.set(key, frame);
          else this.truncated = true;
        }
      }
      if (event.name === "TimeStamp" && event.args?.data?.["message"] === this.label)
        this.marker = event;
      if (!event.ts || !["DrawFrame", "BeginFrame", "LayoutShift", "RunTask"].includes(event.name))
        continue;
      if (event.name === "RunTask" && (event.dur ?? 0) < 50_000) continue;
      if (this.events.length >= this.maxEvents) {
        this.truncated = true;
        continue;
      }
      this.events.push(event);
    }
  }
  result(windowMs: number) {
    const marker = this.marker;
    if (!marker?.ts || marker.pid === undefined)
      throw new Error("Browser trace clock marker missing");
    const start = marker.ts;
    const frame = marker.args?.data?.["frame"];
    const trees = new Set(
      [...this.layerTrees.entries()].filter(([, owner]) => owner === frame).map(([tree]) => tree),
    );
    if (typeof frame !== "string" || trees.size === 0) this.truncated = true;
    const events = this.events.filter(
      (e) =>
        e.pid === marker.pid &&
        (!["DrawFrame", "BeginFrame"].includes(e.name) ||
          trees.has(`${e.pid}:${e.args?.layerTreeId ?? -1}`)) &&
        (e.name !== "LayoutShift" ||
          e.args?.data?.["frame"] === undefined ||
          e.args.data["frame"] === frame) &&
        e.ts !== undefined &&
        e.ts >= start &&
        e.ts <= start + windowMs * 1000,
    );
    const times = (name: string) =>
      events
        .filter((e) => e.name === name)
        .flatMap((e) => (e.ts === undefined ? [] : [(e.ts - start) / 1000]))
        .toSorted((a, b) => a - b);
    const begin = times("BeginFrame"),
      intervals = begin
        .slice(1)
        .flatMap((t, i) => {
          const previous = begin[i];
          return previous === undefined ? [] : [t - previous];
        })
        .filter((gap) => gap >= 4 && gap <= 40)
        .toSorted((a, b) => a - b);
    const interval = intervals[Math.floor(intervals.length * 0.25)];
    const refreshHz = interval ? Math.min(240, Math.round(1000 / interval)) : 60;
    const updates = times("DrawFrame");
    if (updates.length > 2400) this.truncated = true;
    const updatesMs = updates.slice(0, 2400);
    const longTasks = events
      .filter((e) => e.name === "RunTask" && e.tid === marker.tid)
      .flatMap((e) =>
        e.ts === undefined
          ? []
          : [{ atMs: (e.ts - start) / 1000, durationMs: (e.dur ?? 0) / 1000 }],
      );
    if (longTasks.length > 100) this.truncated = true;
    // Largest CLS session: successive shifts less than 1 s apart, at most 5 s total.
    let layoutShift = 0,
      sessionScore = 0,
      sessionStart = -Infinity,
      previous = -Infinity;
    for (const event of events
      .filter((e) => e.name === "LayoutShift" && e.args?.data?.["had_recent_input"] !== true)
      .toSorted((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) {
      const score = event.args?.data?.["score"],
        at = (event.ts ?? 0) / 1000;
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0) continue;
      if (at - previous >= 1000 || at - sessionStart >= 5000) {
        sessionStart = at;
        sessionScore = 0;
      }
      sessionScore += score;
      previous = at;
      layoutShift = Math.max(layoutShift, sessionScore);
    }
    return {
      refreshHz,
      updatesMs,
      longTasks: longTasks.slice(0, 100),
      layoutShift,
      inferredRefresh: !interval,
      truncated: this.truncated,
    };
  }
}

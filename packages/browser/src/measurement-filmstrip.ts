import { Screencast } from "./cdp.ts";
import type { InteractionMeasurement } from "@ace/protocol";
import type { ImageLayer } from "@ace/media/image-wire";
import type { ImageWork } from "@ace/media/images";
export interface Candidate {
  atMs: number;
  data: string;
}
/** Uniform replacement slots retain at most sixteen JPEGs from the existing capture. */
export class MeasurementFrames {
  private slots = new Map<number, Candidate>();
  private active = false;
  constructor(windowMs: number, now: () => number) {
    this.windowMs = windowMs;
    this.now = now;
    this.start = now();
  }
  private windowMs: number;
  private now: () => number;
  private start: number;
  begin(startedAt = this.now()): void {
    this.start = startedAt;
    this.active = true;
  }
  accept(raw: unknown): void {
    if (!this.active) return;
    const parsed = Screencast.safeParse(raw);
    if (!parsed.success || parsed.data.data.length > 512 * 1024) return;
    const atMs = Math.max(0, this.now() - this.start);
    if (atMs > this.windowMs) return;
    const slot = Math.min(15, 1 + Math.floor((atMs / this.windowMs) * 15));
    this.slots.set(slot, { atMs, data: parsed.data.data });
  }
  seed(data: Buffer): void {
    this.slots.set(0, { atMs: 0, data: data.toString("base64") });
  }
  candidates(): Candidate[] {
    return [...this.slots.values()].toSorted((a, b) => a.atMs - b.atMs);
  }
}
/**
 * Up to eight frames around the measurement's moments, four a row, each captioned with its time,
 * drawn by ace-media (ADR 0208) as one JPEG; undefined without image work, when it can't be drawn
 * or when it is over the image bound.
 */
export async function measurementFilmstrip(
  candidates: Candidate[],
  measurement: InteractionMeasurement,
  images: ImageWork | undefined,
) {
  if (!candidates.length || !images) return undefined;
  const times = [
    measurement.latencyMs ?? 0,
    measurement.settleMs ?? measurement.windowMs,
    ...measurement.hitches
      .toSorted((a, b) => b.durationMs - a.durationMs)
      .slice(0, 2)
      .flatMap((h) => [h.atMs, h.atMs + h.durationMs]),
    measurement.windowMs / 2,
  ];
  const chosen: Candidate[] = candidates[0] ? [candidates[0]] : [];
  for (const time of times) {
    const near = candidates.reduce(
      (best, c) => (Math.abs(c.atMs - time) < Math.abs(best.atMs - time) ? c : best),
      candidates[0] ?? { atMs: 0, data: "" },
    );
    if (!chosen.includes(near)) chosen.push(near);
  }
  for (const candidate of candidates) {
    if (chosen.length >= 8) break;
    if (!chosen.includes(candidate)) chosen.push(candidate);
  }
  const ordered = chosen.toSorted((a, b) => a.atMs - b.atMs).slice(0, 8);
  const width = 400,
    height = 250,
    label = 28;
  const layers: ImageLayer[] = [];
  for (const [index, c] of ordered.entries()) {
    const hitch = measurement.hitches.some(
      (h) => c.atMs >= h.atMs - 30 && c.atMs <= h.atMs + h.durationMs + 30,
    );
    const left = (index % 4) * width;
    const top = Math.floor(index / 4) * (height + label);
    layers.push(
      { kind: "image", input: index, left, top, width, height, fit: "contain" },
      {
        kind: "text",
        text: `${c.atMs >= 0 ? "+" : ""}${Math.round(c.atMs)} ms${hitch ? " HITCH" : ""}`,
        left: left + 8,
        top: top + height + 7,
        size: 16,
        color: hitch ? [255, 139, 106, 255] : [255, 255, 255, 255],
      },
    );
  }
  const strip = await images
    .run({
      inputs: ordered.map((c) => ({ kind: "bytes", bytes: Buffer.from(c.data, "base64") })),
      op: {
        op: "compose",
        width: 1600,
        height: 2 * (height + label),
        background: [24, 24, 24, 255],
        maxPixels: 16_777_216,
        layers,
        output: { format: "jpeg", quality: 65, background: [24, 24, 24] },
      },
      deadlineMs: 10_000,
    })
    .catch(() => undefined);
  if (!strip || strip.bytes.byteLength > 750 * 1024) return undefined;
  return {
    type: "image" as const,
    mimeType: "image/jpeg" as const,
    data: Buffer.from(strip.bytes).toString("base64"),
  };
}

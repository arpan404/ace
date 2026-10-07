import { Screencast } from "./cdp.ts";
import type { InteractionMeasurement } from "@ace/protocol";
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
export async function measurementFilmstrip(
  candidates: Candidate[],
  measurement: InteractionMeasurement,
) {
  if (!candidates.length) return undefined;
  const { default: sharp } = await import("sharp");
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
  const ordered = chosen.toSorted((a, b) => a.atMs - b.atMs);
  const width = 400,
    height = 250,
    label = 28;
  const tiles = [];
  for (const [index, c] of ordered.slice(0, 8).entries()) {
    const hitch = measurement.hitches.some(
      (h) => c.atMs >= h.atMs - 30 && c.atMs <= h.atMs + h.durationMs + 30,
    );
    const pixels = await sharp(Buffer.from(c.data, "base64"), { limitInputPixels: 16_777_216 })
      .resize(width, height, { fit: "contain", background: "#181818" })
      .toBuffer();
    const caption = Buffer.from(
      `<svg width="${width}" height="${label}"><rect width="100%" height="100%" fill="#181818"/><text x="8" y="20" font-size="16" font-family="sans-serif" fill="${hitch ? "#ff8b6a" : "white"}">${c.atMs >= 0 ? "+" : ""}${Math.round(c.atMs)} ms${hitch ? " HITCH" : ""}</text></svg>`,
    );
    tiles.push(
      { input: pixels, left: (index % 4) * width, top: Math.floor(index / 4) * (height + label) },
      {
        input: caption,
        left: (index % 4) * width,
        top: Math.floor(index / 4) * (height + label) + height,
      },
    );
  }
  const bytes = await sharp({
    create: { width: 1600, height: 2 * (height + label), channels: 3, background: "#181818" },
  })
    .composite(tiles)
    .jpeg({ quality: 65 })
    .toBuffer();
  if (bytes.byteLength > 750 * 1024) return undefined;
  return {
    type: "image" as const,
    mimeType: "image/jpeg" as const,
    data: bytes.toString("base64"),
  };
}

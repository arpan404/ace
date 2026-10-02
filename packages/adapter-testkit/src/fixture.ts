import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Frame } from "@ace/engine-api";

export const RecordingHeader = z.looseObject({
  format: z.literal("ace-recording/v1"),
  provider: z.string(),
  cliVersion: z.string(),
  scenario: z.string(),
  startedAt: z.string(),
  platform: z.string(),
  workspace: z.string(),
});
export type RecordingHeader = z.infer<typeof RecordingHeader>;

const FrameSchema = z.looseObject({
  seq: z.number().int().nonnegative(),
  t: z.number().int().nonnegative(),
  dir: z.enum(["send", "recv", "stderr", "note"]),
  channel: z.string(),
  data: z.unknown(),
});

export interface Fixture {
  header: RecordingHeader;
  frames: Frame[];
}

/** Reject broken ordering rather than silently changing the provider transcript. */
export function validateFrames(frames: readonly Frame[]): void {
  let seq = -1;
  let t = 0;
  for (const frame of frames) {
    FrameSchema.parse(frame);
    if (frame.seq <= seq || frame.t < t)
      throw new Error(`frame seq=${frame.seq} t=${frame.t}: sequence/time moved backwards`);
    seq = frame.seq;
    t = frame.t;
  }
}

export async function readFixture(path: string): Promise<Fixture> {
  const lines = (await readFile(path, "utf8")).split(/\r?\n/);
  const rows: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      rows.push(rows.length === 0 ? RecordingHeader.parse(value) : FrameSchema.parse(value));
    } catch (error) {
      throw new Error(`${path}:${index + 1}: ${String(error)}`, { cause: error });
    }
  }
  const header = RecordingHeader.parse(rows[0]);
  const frames = rows.slice(1).map((row) => FrameSchema.parse(row));
  validateFrames(frames);
  return { header, frames };
}

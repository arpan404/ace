import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RecordedPart, RecordingEnd } from "../recordings.ts";
import type {
  ActiveRecording,
  MediaRecorder,
  RecordingStart,
  TeeRecordingSpec,
} from "../tee-recordings.ts";
import type { TeeUnit } from "../tee.ts";

/** One recording a test's `FakeMediaRecorder` took: its spec and every unit pushed to it. */
export type FakeRecording = {
  spec: TeeRecordingSpec;
  units: TeeUnit[];
  /** Privacy transitions the producer reported. */
  privacy: number;
  stopped: boolean;
};

/**
 * ace-media's recorder as a test sees it: each recording keeps what was pushed, and writes the
 * pushed payloads as its parts, so a caller publishes real files. The last part closes at stop,
 * or once it holds `partBytes` (reported through `spec.part`, as ace-media reports a part).
 * `refuse` makes every start refuse with that reason, as ace-media unavailable does.
 */
export class FakeMediaRecorder implements MediaRecorder {
  readonly recordings: FakeRecording[] = [];
  refuse: string | undefined;
  partBytes: number | undefined;

  start(spec: TeeRecordingSpec): Promise<RecordingStart> {
    if (this.refuse) return Promise.resolve({ ok: false, reason: this.refuse });
    const taken: FakeRecording = { spec, units: [], privacy: 0, stopped: false };
    this.recordings.push(taken);
    const parts: RecordedPart[] = [];
    let open: Uint8Array[] = [];
    const close = (): RecordedPart | undefined => {
      if (!open.length) return undefined;
      mkdirSync(spec.directory, { recursive: true, mode: 0o700 });
      const index = parts.length;
      const path = join(spec.directory, `part-${String(index).padStart(4, "0")}.mp4`);
      const bytes = Buffer.concat(open);
      open = [];
      writeFileSync(path, bytes, { mode: 0o600 });
      const part = { path, index, bytes: bytes.length, durationMs: 0, gaps: 0 };
      parts.push(part);
      return part;
    };
    const recording: ActiveRecording = {
      push: (unit) => {
        if (taken.stopped) return;
        taken.units.push(unit);
        open.push(unit.payload);
        const limit = this.partBytes;
        if (limit === undefined || open.reduce((sum, bytes) => sum + bytes.length, 0) < limit)
          return;
        const part = close();
        if (part) spec.part?.(part);
      },
      privacy: () => void taken.privacy++,
      parts,
      stop: (): Promise<RecordingEnd> => {
        if (!taken.stopped) {
          taken.stopped = true;
          close();
        }
        return Promise.resolve({ ok: true, parts: [...parts] });
      },
    };
    return Promise.resolve({ ok: true, recording });
  }

  /** The most recent recording. */
  last(): FakeRecording | undefined {
    return this.recordings.at(-1);
  }
}

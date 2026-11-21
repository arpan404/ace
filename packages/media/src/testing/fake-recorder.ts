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
 * ace-media's recorder as a test sees it: each recording keeps what was pushed, and its stop
 * writes one part holding the pushed payloads, so a caller publishes a real file. `refuse`
 * makes every start refuse with that reason, as ace-media unavailable does.
 */
export class FakeMediaRecorder implements MediaRecorder {
  readonly recordings: FakeRecording[] = [];
  refuse: string | undefined;

  start(spec: TeeRecordingSpec): Promise<RecordingStart> {
    if (this.refuse) return Promise.resolve({ ok: false, reason: this.refuse });
    const taken: FakeRecording = { spec, units: [], privacy: 0, stopped: false };
    this.recordings.push(taken);
    const parts: RecordedPart[] = [];
    const recording: ActiveRecording = {
      push: (unit) => {
        if (!taken.stopped) taken.units.push(unit);
      },
      privacy: () => void taken.privacy++,
      parts,
      stop: (): Promise<RecordingEnd> => {
        taken.stopped = true;
        if (!taken.units.length) return Promise.resolve({ ok: true, parts });
        mkdirSync(spec.directory, { recursive: true, mode: 0o700 });
        const path = join(spec.directory, "part-0000.mp4");
        const bytes = Buffer.concat(taken.units.map((unit) => unit.payload));
        writeFileSync(path, bytes, { mode: 0o600 });
        parts.push({ path, index: 0, bytes: bytes.length, durationMs: 0, gaps: 0 });
        return Promise.resolve({ ok: true, parts });
      },
    };
    return Promise.resolve({ ok: true, recording });
  }

  /** The most recent recording. */
  last(): FakeRecording | undefined {
    return this.recordings.at(-1);
  }
}

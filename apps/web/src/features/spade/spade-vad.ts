/*
 * Voice activity detection, on the device (ADR 0134, amended): is the person talking, and have
 * they stopped? It reads only the microphone's loudness, frame by frame, against a noise floor it
 * learns while nobody talks. Nothing is recorded or sent by it. The caller measures each frame
 * (an AnalyserNode's RMS in the page) and passes the time in, so this is pure.
 */

export interface VadOptions {
  /** Loud for this long before it counts as talking (a cough or a click is shorter). */
  startMs: number;
  /** Quiet for this long after talking before the person is taken to have finished. */
  endMs: number;
  /** How far above the noise floor talking is. */
  ratio: number;
  /** The quietest level that ever counts as talking, whatever the floor. */
  least: number;
  /** The loudest a room is taken to be before it is heard: talking from the first frame on. */
  quietRoom: number;
  /** One stretch of talking ends after this long, so a loud room can't hold it open. */
  longestMs: number;
}

export const defaultVad: VadOptions = {
  startMs: 160,
  endMs: 900,
  ratio: 3,
  least: 0.012,
  quietRoom: 0.01,
  longestMs: 30_000,
};

export type VadEvent = "speech-start" | "speech-end";

export interface Vad {
  /** One frame's loudness (RMS, 0–1) at `at` ms; says when talking starts or ends. */
  step(level: number, at: number): VadEvent | undefined;
  /** Whether the person is talking now. */
  readonly talking: boolean;
  /**
   * Raise the bar for a while: while ace itself speaks, only a voice clearly louder than the
   * speakers' echo interrupts it. `1` puts it back.
   */
  setDamping(times: number): void;
}

export function createVad(options: VadOptions = defaultVad): Vad {
  let floor: number | undefined;
  let talking = false;
  let loudSince: number | undefined;
  let talkingSince = 0;
  let quietSince: number | undefined;
  let damping = 1;

  return {
    get talking() {
      return talking;
    },
    setDamping(times) {
      damping = Math.max(1, times);
    },
    step(level, at) {
      const heard = Math.max(0, level);
      // Never louder than a quiet room to begin with: someone talking as the microphone opens
      // is heard, not taken for the room.
      floor ??= Math.min(heard, options.quietRoom);
      const bar = Math.max(floor * options.ratio, options.least) * damping;
      // The floor follows a quieter room quickly and a noisier one slowly, and never learns
      // from a frame loud enough to be a voice.
      if (!talking && heard < bar) floor += (heard - floor) * (heard < floor ? 0.2 : 0.02);
      if (!talking) {
        if (heard < bar) {
          loudSince = undefined;
          return undefined;
        }
        loudSince ??= at;
        if (at - loudSince < options.startMs) return undefined;
        talking = true;
        talkingSince = at;
        quietSince = undefined;
        return "speech-start";
      }
      if (at - talkingSince >= options.longestMs) {
        // Nobody talks this long without a pause: this loudness is the room's.
        floor = heard;
        talking = false;
        loudSince = undefined;
        return "speech-end";
      }
      // Quieter than the start's bar, so a voice that dips a little isn't taken as an end.
      if (heard >= bar * 0.6) {
        quietSince = undefined;
        return undefined;
      }
      quietSince ??= at;
      if (at - quietSince < options.endMs) return undefined;
      talking = false;
      loudSince = undefined;
      return "speech-end";
    },
  };
}

/** The loudness of one frame of samples (-1…1), as root mean square. */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

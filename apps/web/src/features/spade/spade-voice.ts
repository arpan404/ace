/*
 * Voice in (ADR 0134): the microphone recorded with MediaRecorder, and, where the browser has
 * it, the Web Speech API listening alongside to turn the words into text on the device. Spade's
 * own `POST /v1/transcriptions` is the fallback the composer reaches for when that's missing or
 * fails (Electron usually answers `network`).
 */

/** The parts of `SpeechRecognition` used here; browsers name it with or without `webkit`. */
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  addEventListener(type: "result", listener: (event: RecognitionResults) => void): void;
  addEventListener(type: "error", listener: (event: { error: string }) => void): void;
  addEventListener(type: "end", listener: () => void): void;
  start(): void;
  stop(): void;
  abort(): void;
}

interface RecognitionResults {
  results: ArrayLike<{ isFinal: boolean; 0?: { transcript: string } }>;
}

type RecognitionConstructor = new () => Recognition;

const scope = globalThis as unknown as Record<string, unknown>;

function recognitionConstructor(): RecognitionConstructor | undefined {
  const found = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  return typeof found === "function" ? (found as RecognitionConstructor) : undefined;
}

/** The browser can turn speech into words itself. */
export function hasSpeechRecognition(): boolean {
  return recognitionConstructor() !== undefined;
}

/** The browser can record the microphone. */
export function canRecordVoice(): boolean {
  return (
    typeof MediaRecorder === "function" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

/** Errors that mean on-device recognition can't work here, not just that nothing was said. */
const brokenRecognition = new Set([
  "network",
  "not-allowed",
  "service-not-allowed",
  "language-not-supported",
  "audio-capture",
]);

export interface VoiceTake {
  recording: Blob;
  /** What on-device recognition heard; empty when it heard nothing or didn't run. */
  heard: string;
  /** On-device recognition can't work here: use Spade's endpoint instead from now on. */
  recognitionBroken: boolean;
}

export interface VoiceSession {
  /** Stop recording; resolves once the recording and any recognition are done. */
  finish(): Promise<VoiceTake>;
  /** Stop and drop everything. */
  cancel(): void;
}

/** How long to wait for recognition to settle after the recording stops. */
const settleMs = 3_000;

/**
 * Start recording, with on-device recognition alongside when `recognize`. Once `signal` aborts
 * nothing starts: a microphone granted after that is released at once and this rejects.
 */
export async function startVoice(recognize: boolean, signal: AbortSignal): Promise<VoiceSession> {
  signal.throwIfAborted();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  if (signal.aborted) {
    for (const track of stream.getTracks()) track.stop();
    signal.throwIfAborted();
  }
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  const stopped = new Promise<void>((resolve) =>
    recorder.addEventListener("stop", () => resolve(), { once: true }),
  );
  recorder.start();

  let heard = "";
  let broken = false;
  let ended: Promise<void> = Promise.resolve();
  let recognition: Recognition | undefined;
  const Constructor = recognize ? recognitionConstructor() : undefined;
  if (Constructor) {
    const running = new Constructor();
    recognition = running;
    running.continuous = true;
    running.interimResults = false;
    running.lang = navigator.language || "en-US";
    running.addEventListener("result", (event) => {
      heard = Array.from(event.results)
        .filter((result) => result.isFinal)
        .map((result) => result[0]?.transcript.trim() ?? "")
        .filter(Boolean)
        .join(" ");
    });
    running.addEventListener("error", (event) => {
      if (brokenRecognition.has(event.error)) broken = true;
    });
    ended = new Promise((resolve) => running.addEventListener("end", () => resolve()));
    try {
      running.start();
    } catch {
      broken = true;
      recognition = undefined;
      ended = Promise.resolve();
    }
  }

  const release = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  return {
    async finish() {
      recognition?.stop();
      if (recorder.state !== "inactive") recorder.stop();
      await stopped;
      release();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        ended,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, settleMs);
        }),
      ]);
      clearTimeout(timer);
      const type = recorder.mimeType || chunks[0]?.type || "audio/webm";
      return {
        recording: new Blob(chunks, { type }),
        heard: heard.trim(),
        recognitionBroken: broken,
      };
    },
    cancel() {
      recognition?.abort();
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
  };
}

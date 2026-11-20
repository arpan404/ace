import { vi } from "vitest";

/*
 * Stand-ins for the page's voice edges, for Spade's voice tests: the system's speech, the
 * microphone with a loudness the test sets, a recorder, and audio playback. Only the browser
 * APIs are replaced; everything of ace's runs as it does.
 */

/** The system's speech: what was said, in order, and how often it was cut off. */
export function withSystemSpeech(options: { endsAfterMs?: number } = {}) {
  const said: string[] = [];
  const counts = { cancels: 0 };
  let speaking: EventTarget | undefined;
  class Utterance extends EventTarget {
    text: string;
    voice: unknown = null;
    constructor(text: string) {
      super();
      this.text = text;
    }
  }
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  vi.stubGlobal("speechSynthesis", {
    speak(utterance: Utterance) {
      said.push(utterance.text);
      speaking = utterance;
      // Undefined: it speaks until cut off, as a long sentence would.
      if (options.endsAfterMs !== undefined)
        setTimeout(() => {
          if (speaking === utterance) utterance.dispatchEvent(new Event("end"));
        }, options.endsAfterMs);
    },
    cancel() {
      counts.cancels++;
      const cut = speaking;
      speaking = undefined;
      cut?.dispatchEvent(new Event("end"));
    },
    getVoices: () => [],
  });
  return { said, counts };
}

/**
 * A microphone whose loudness the test sets (`level`), a recorder that counts recordings, and
 * the page's audio graph reading that loudness.
 */
export function withLoudMicrophone() {
  const mic = { level: 0.004, recordings: 0, opened: 0, released: 0 };
  class FakeRecorder extends EventTarget {
    state: "inactive" | "recording" = "inactive";
    mimeType = "audio/webm";
    start() {
      mic.recordings++;
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.dispatchEvent(
        Object.assign(new Event("dataavailable"), {
          data: new Blob(["spoken"], { type: "audio/webm" }),
        }),
      );
      this.dispatchEvent(new Event("stop"));
    }
  }
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () => {
        mic.opened++;
        return Promise.resolve({ getTracks: () => [{ stop: () => mic.released++ }] });
      },
    },
  });
  class FakeAudioContext {
    createAnalyser() {
      return {
        fftSize: 1024,
        getFloatTimeDomainData(samples: Float32Array) {
          samples.fill(mic.level);
        },
      };
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    close() {
      return Promise.resolve();
    }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  return mic;
}

/** Audio playback that plays each clip for `ms`, recording which object URLs were played. */
export function withAudioPlayback(ms = 30) {
  const played: string[] = [];
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    played.push(this.src);
    setTimeout(() => this.dispatchEvent(new Event("ended")), ms);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  return played;
}

/** Talk for `ms`, then fall quiet for `quiet` ms. */
export async function talk(mic: { level: number }, ms = 400, quiet = 1_300) {
  mic.level = 0.2;
  await new Promise((resolve) => setTimeout(resolve, ms));
  mic.level = 0.004;
  await new Promise((resolve) => setTimeout(resolve, quiet));
}

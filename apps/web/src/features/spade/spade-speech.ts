import { useSyncExternalStore } from "react";
import { speakWords } from "./spade-api.ts";
import type { SpadeTarget } from "./spade-requests.ts";
import { spokenSentences } from "./spade-spoken-reply.ts";

/*
 * Voice out (ADR 0134, amended): a bot's words spoken by the system's own voices
 * (`speechSynthesis`, on the device) or by the person's speech model through Spade (`POST
 * /v1/speech`, so the key stays in the keychain). Words come in sentences (`spokenReply`); the
 * first is spoken alone so speech starts at once, later ones in small groups, and the next group
 * is fetched while one plays. One thing speaks at a time: a new turn stops the last. Esc, Stop,
 * or the person starting to talk stops it at once.
 */

export type SpeechVoice =
  | { engine: "system"; voice: string | undefined }
  | { engine: "endpoint"; voice: string | undefined; target: SpadeTarget };

/** One group of words, ready to play: fetching (endpoint) starts as soon as it is made. */
interface Clip {
  play(): Promise<void>;
  stop(): void;
}

/** The system can speak. */
export function canReadAloud(): boolean {
  return typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance === "function";
}

/** Whether `voice` can speak here. */
export function canSpeakWith(voice: SpeechVoice | undefined): boolean {
  return voice?.engine === "endpoint" || (voice !== undefined && canReadAloud());
}

/** The system's voices, as far as it has loaded them. */
export function systemVoices(): SpeechSynthesisVoice[] {
  if (!canReadAloud() || typeof speechSynthesis.getVoices !== "function") return [];
  return speechSynthesis.getVoices();
}

function systemClip(words: string, voiceUri: string | undefined): Clip {
  return {
    play: () =>
      new Promise<void>((resolve) => {
        const utterance = new SpeechSynthesisUtterance(words);
        const chosen = voiceUri && systemVoices().find((each) => each.voiceURI === voiceUri);
        if (chosen) utterance.voice = chosen;
        utterance.addEventListener("end", () => resolve());
        utterance.addEventListener("error", () => resolve());
        speechSynthesis.speak(utterance);
      }),
    stop: () => {
      if (canReadAloud()) speechSynthesis.cancel();
    },
  };
}

function endpointClip(target: SpadeTarget, words: string, voice: string | undefined): Clip {
  const controller = new AbortController();
  const audio = speakWords(target, words, voice, controller.signal);
  // A clip stopped before it played still settles its fetch quietly.
  audio.catch(() => {});
  let element: HTMLAudioElement | undefined;
  let url: string | undefined;
  let finish: (() => void) | undefined;
  const release = () => {
    if (url) URL.revokeObjectURL(url);
    url = undefined;
  };
  return {
    async play() {
      const blob = await audio;
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      const playing = new Audio(url);
      element = playing;
      await new Promise<void>((resolve, reject) => {
        finish = resolve;
        playing.addEventListener("ended", () => resolve());
        playing.addEventListener("error", () => reject(new Error("The audio couldn't be played.")));
        playing.play().catch(reject);
      }).finally(release);
    },
    stop() {
      controller.abort();
      element?.pause();
      finish?.();
      release();
    },
  };
}

/** The first group is one sentence, so speech starts at once; later ones gather a few. */
const groupChars = 280;

interface TurnHooks {
  done(turn: Turn): void;
  trouble(error: unknown): void;
  began(): void;
}

class Turn {
  readonly key: string;
  private queue: string[] = [];
  private ready: Clip[] = [];
  private playing: Clip | undefined;
  private closed = false;
  private stopped = false;
  private started = false;
  private readonly voice: SpeechVoice;
  private readonly hooks: TurnHooks;

  constructor(key: string, voice: SpeechVoice, hooks: TurnHooks) {
    this.key = key;
    this.voice = voice;
    this.hooks = hooks;
  }

  get audible() {
    return this.started && !this.stopped;
  }

  add(sentences: readonly string[]) {
    if (this.stopped || sentences.length === 0) return;
    this.queue.push(...sentences);
    this.pump();
  }

  close() {
    this.closed = true;
    this.pump();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.queue = [];
    this.playing?.stop();
    for (const clip of this.ready) clip.stop();
    this.ready = [];
    this.hooks.done(this);
  }

  private take(): string {
    let words = this.queue.shift() ?? "";
    if (!this.started && this.ready.length === 0) return words;
    while (this.queue.length && words.length + (this.queue[0]?.length ?? 0) < groupChars)
      words = `${words} ${this.queue.shift() ?? ""}`;
    return words;
  }

  private clip(words: string): Clip {
    return this.voice.engine === "endpoint"
      ? endpointClip(this.voice.target, words, this.voice.voice)
      : systemClip(words, this.voice.voice);
  }

  private pump() {
    if (this.stopped) return;
    // Endpoint audio is fetched a group ahead, so the next words are ready when these end.
    const ahead = this.voice.engine === "endpoint" ? 2 : 1;
    while (this.ready.length < ahead && this.queue.length) this.ready.push(this.clip(this.take()));
    if (this.playing) return;
    const next = this.ready.shift();
    if (!next) {
      if (this.closed) {
        this.stopped = true;
        this.hooks.done(this);
      }
      return;
    }
    this.playing = next;
    if (!this.started) {
      this.started = true;
      this.hooks.began();
    }
    void next
      .play()
      .catch((error: unknown) => {
        if (this.stopped) return;
        this.hooks.trouble(error);
        this.stop();
      })
      .finally(() => {
        if (this.playing === next) this.playing = undefined;
        this.pump();
      });
  }
}

/** A reply being spoken while it is written. */
export interface LiveSpeech {
  add(sentences: readonly string[]): void;
  /** No more words will come: it ends once what is queued is said. */
  close(): void;
  stop(): void;
}

let current: Turn | undefined;
const listeners = new Set<() => void>();
const troubleListeners = new Set<(error: unknown) => void>();

function changed() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Esc stops speech wherever focus is, while something speaks. */
const escape = (event: KeyboardEvent) => {
  if (event.key === "Escape") stopSpeaking();
};

/** Start speaking as `key` in `voice`, stopping whatever spoke before. */
export function speakTurn(key: string, voice: SpeechVoice): LiveSpeech {
  current?.stop();
  const turn = new Turn(key, voice, {
    done(ended) {
      if (current !== ended) return;
      current = undefined;
      window.removeEventListener("keydown", escape, true);
      changed();
    },
    trouble(error) {
      for (const listener of troubleListeners) listener(error);
    },
    began: changed,
  });
  current = turn;
  window.addEventListener("keydown", escape, true);
  changed();
  return {
    add: (sentences) => turn.add(sentences),
    close: () => turn.close(),
    stop: () => turn.stop(),
  };
}

/** Speak a finished reply (`key`), as Read aloud does. */
export function readAloud(key: string, text: string, voice: SpeechVoice) {
  const turn = speakTurn(key, voice);
  turn.add(spokenSentences(text));
  turn.close();
}

/** Stop speaking at once, whatever speaks. */
export function stopSpeaking() {
  current?.stop();
  if (canReadAloud()) speechSynthesis.cancel();
}

/** Read aloud's Stop reading. */
export const stopReading = stopSpeaking;

/** Stop if `key` is what speaks (its bubble or chat is going away). */
export function stopReadingOf(key: string) {
  if (current?.key === key) stopSpeaking();
}

/** Whether `key` is speaking now (queued words count: it is its turn). */
export function useReading(key: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => current?.key === key,
    () => false,
  );
}

/** What speaks now, and whether its sound has started. */
export function speakingNow(): { key: string; audible: boolean } | undefined {
  return current ? { key: current.key, audible: current.audible } : undefined;
}

/** Hears every change of what speaks. */
export function onSpeechChange(listener: () => void): () => void {
  return subscribe(listener);
}

/** Hears a voice that failed (the speech model's endpoint refused, audio didn't play). */
export function onSpeechTrouble(listener: (error: unknown) => void): () => void {
  troubleListeners.add(listener);
  return () => {
    troubleListeners.delete(listener);
  };
}

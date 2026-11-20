import { useEffect, useState, useSyncExternalStore } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { prepareSpadeVoice, type PreparedVoice } from "./spade-attachments.ts";
import { transcribe } from "./spade-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import type { SpadeTarget } from "./spade-requests.ts";
import { onSpeechChange, speakingNow, stopSpeaking } from "./spade-speech.ts";
import {
  talkOff,
  talkStep,
  type TalkEffect,
  type TalkEvent,
  type TalkState,
} from "./spade-talk.ts";
import { createVad, rms, type Vad } from "./spade-vad.ts";
import { openMicrophone, startVoice, type VoiceSession, type VoiceTake } from "./spade-voice.ts";

/*
 * A spoken conversation in the composer (ADR 0134, amended): the shell around `talkStep`. It
 * keeps one microphone open while the conversation lasts, measures it every frame for the
 * detector, records only while the person talks, and sends what they said with its recording.
 * Push to talk is the same conversation for one turn: it ends once the reply has been spoken.
 * The recording stays in this window and is sent only with its words; nothing else leaves it.
 */

/** How often the microphone is measured. */
const frameMs = 40;
/** While ace speaks, only a voice this many times louder than the echo interrupts it. */
const echoDamping = 3;
/** A push-to-talk press with nothing said ends after this long. */
const pushIdleMs = 8_000;

/** Words heard, from the device or the transcription model, with the recording. */
export async function wordsOf(
  take: VoiceTake,
  heardBy: (prepared: PreparedVoice) => Promise<string>,
): Promise<{ words: string; voice: PreparedVoice }> {
  const voice = await prepareSpadeVoice(take.recording);
  const words = take.heard || (await heardBy(voice)).trim();
  return { words, voice };
}

export interface TalkOptions {
  /** On-device recognition can be tried here. */
  recognize: boolean;
  transcriptionModel: string | undefined;
  /** The bot is working on an answer. */
  answering: boolean;
  /** Sends the words, spoken: the reply that answers them is read aloud. */
  send(words: string, voice: PreparedVoice): Promise<boolean>;
  /** A step failed in a way the person should hear of. */
  fail(title: string, error?: unknown): void;
  /** The state changed, and whether this is push to talk (the desktop's indicator follows it). */
  changed?: ((state: TalkState, push: boolean) => void) | undefined;
}

interface Open {
  stream: MediaStream;
  context: AudioContext;
  timer: ReturnType<typeof setInterval>;
  vad: Vad;
  /** Push to talk: one turn. */
  once: boolean;
  /** The answer to what was sent has begun (the bot worked, or something is being said). */
  sawAnswer: boolean;
}

/** One composer's spoken conversation: the microphone, the detector and the turn. */
export class TalkController {
  private state: TalkState = talkOff;
  private open: Open | undefined;
  private recording: VoiceSession | undefined;
  private heard: PreparedVoice | undefined;
  private listeners = new Set<() => void>();
  private options: TalkOptions;
  private target: SpadeTarget;
  private stopSpeech: (() => void) | undefined;

  constructor(target: SpadeTarget, options: TalkOptions) {
    this.target = target;
    this.options = options;
  }

  update(target: SpadeTarget, options: TalkOptions) {
    this.target = target;
    this.options = options;
  }

  get current(): TalkState {
    return this.state;
  }

  /** Whether this conversation is push to talk. */
  get pushing(): boolean {
    return this.open?.once === true;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = () => this.state;

  /** Opens the microphone and starts listening; `once` for push to talk. */
  async start(once: boolean) {
    if (this.open) return;
    stopSpeaking();
    let stream: MediaStream;
    try {
      stream = await openMicrophone(new AbortController().signal);
    } catch (error) {
      this.options.fail("Couldn't use the microphone", error);
      this.options.changed?.(talkOff, once);
      return;
    }
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const vad = createVad();
    const timer = setInterval(() => this.frame(analyser, samples), frameMs);
    this.open = { stream, context, timer, vad, once, sawAnswer: false };
    // The reply's speech beginning is the bot's turn to speak.
    this.stopSpeech = onSpeechChange(() => {
      if (speakingNow()?.audible && this.state.kind === "thinking") this.dispatch({ kind: "speaking" });
    });
    this.dispatch({ kind: "start", at: Date.now() });
  }

  /** Send now what has been said (a second press of the shortcut); nothing said ends it. */
  sendNow() {
    if (this.state.kind === "hearing") this.dispatch({ kind: "speech-end" });
    else if (this.state.kind === "listening") this.dispatch({ kind: "end" });
  }

  end() {
    this.dispatch({ kind: "end" });
  }

  /** Lets go of everything (the chat is going away). */
  dispose() {
    if (this.state.kind !== "off") this.dispatch({ kind: "end" });
    this.release();
  }

  private frame(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>) {
    const open = this.open;
    if (!open) return;
    const at = Date.now();
    analyser.getFloatTimeDomainData(samples);
    const heard = open.vad.step(rms(samples), at);
    if (heard) this.dispatch({ kind: heard });
    if (this.options.answering || speakingNow()) open.sawAnswer = true;
    // The person's turn again: the answer came and nothing is being said.
    const kind = this.state.kind;
    if (
      (kind === "thinking" || kind === "speaking") &&
      open.sawAnswer &&
      !this.options.answering &&
      !speakingNow()
    )
      this.dispatch({ kind: "turn-over", at });
    this.dispatch({ kind: "tick", at });
  }

  private dispatch(event: TalkEvent) {
    const open = this.open;
    const step = talkStep(this.state, event, open?.once ? pushIdleMs : undefined);
    // Push to talk is one turn: once the reply is over, the conversation is too.
    const next = open?.once && event.kind === "turn-over" ? talkOff : step.state;
    const before = this.state;
    this.state = next;
    if (before !== next) {
      open?.vad.setDamping(next.kind === "speaking" ? echoDamping : 1);
      this.options.changed?.(next, open?.once === true);
      for (const listener of this.listeners) listener();
    }
    for (const effect of step.effects) this.run(effect, step.words);
    if (next.kind === "off") this.release();
  }

  private release() {
    const open = this.open;
    this.open = undefined;
    this.recording?.cancel();
    this.recording = undefined;
    this.stopSpeech?.();
    this.stopSpeech = undefined;
    if (!open) return;
    clearInterval(open.timer);
    void open.context.close().catch(() => {});
    for (const track of open.stream.getTracks()) track.stop();
  }

  private failed() {
    this.dispatch({ kind: "failed", at: Date.now() });
  }

  private run(effect: TalkEffect, words: string | undefined) {
    const open = this.open;
    switch (effect) {
      case "stop-speaking":
        stopSpeaking();
        return;
      case "record":
        if (!open) return;
        // The person talking stops the bot talking.
        stopSpeaking();
        void startVoice(this.options.recognize, new AbortController().signal, open.stream).then(
          (session) => {
            if (this.state.kind === "hearing" && this.open === open) this.recording = session;
            else session.cancel();
          },
          () => this.failed(),
        );
        return;
      case "discard-recording":
        this.recording?.cancel();
        this.recording = undefined;
        return;
      case "transcribe": {
        const session = this.recording;
        this.recording = undefined;
        if (!session) return this.failed();
        const model = this.options.transcriptionModel;
        void session
          .finish()
          .then((take) =>
            wordsOf(take, (voice) =>
              model !== undefined ? transcribe(this.target, voice) : Promise.resolve(""),
            ),
          )
          .then(
            ({ words: said, voice }) => {
              this.heard = voice;
              this.dispatch({ kind: "words", words: said, at: Date.now() });
            },
            (error: unknown) => {
              this.options.fail("Couldn't turn the recording into words", error);
              this.failed();
            },
          );
        return;
      }
      case "send": {
        const voice = this.heard;
        this.heard = undefined;
        if (!words || !voice) return;
        if (open) open.sawAnswer = false;
        void this.options.send(words, voice).then((sent) => {
          if (!sent) this.failed();
        });
        return;
      }
      case "ended-quietly":
        return;
    }
  }
}

/** The composer's spoken conversation, kept current with its options. */
export function useTalkMode(options: Omit<TalkOptions, "fail">) {
  const client = useSpadeClient();
  const toast = useToast();
  const full: TalkOptions = {
    ...options,
    fail: (title, error) =>
      toast.error({ title, description: error instanceof Error ? error.message : undefined }),
  };
  const [controller] = useState(() => new TalkController(client, full));
  useEffect(() => controller.update(client, full));
  // Leaving the chat ends the conversation and lets go of the microphone.
  useEffect(() => () => controller.dispose(), [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  return {
    state,
    /** Hands free: listens again after every reply until ended or quiet for a while. */
    start: () => void controller.start(false),
    /** Push to talk: one turn. */
    push: () => void controller.start(true),
    sendNow: () => controller.sendNow(),
    end: () => controller.end(),
    /** This conversation is push to talk. */
    pushing: state.kind !== "off" && controller.pushing,
  };
}

export type TalkMode = ReturnType<typeof useTalkMode>;

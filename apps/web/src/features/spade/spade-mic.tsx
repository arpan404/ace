import { MicrophoneIcon, WaveformIcon } from "@ace/icons";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { StripSurface } from "@/features/thread/index.ts";
import type { PreparedVoice } from "./spade-attachments.ts";
import { transcribe } from "./spade-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { stopSpeaking } from "./spade-speech.ts";
import { talkLine } from "./spade-talk.ts";
import type { TalkMode } from "./spade-talk-mode.ts";
import { wordsOf } from "./spade-talk-mode.ts";
import { TranscriptionSetup } from "./spade-voice-setup.tsx";
import {
  canRecordVoice,
  hasSpeechRecognition,
  startVoice,
  type VoiceSession,
} from "./spade-voice.ts";

type VoiceState = "idle" | "starting" | "recording" | "transcribing";

/** A press shorter than this is a tap: it starts recording, and the next press stops it. */
const holdMs = 400;

/**
 * Voice in (ADR 0134): hold the mic to record, or tap it to start and again to stop; Space or
 * Enter toggles it. The words are heard on the device where the browser can, else by the
 * transcription model; they land in the message to be checked, and the recording rides along.
 * Without either way to turn speech into words, the mic offers the person's endpoints that can
 * (`TranscriptionSetup`), one click each. Starting to talk stops anything being read aloud.
 */
export function useSpadeVoice(props: {
  transcriptionModel: string | undefined;
  onWords(words: string): void;
}) {
  const client = useSpadeClient();
  const toast = useToast();
  const [state, setState] = useState<VoiceState>("idle");
  const [voice, setVoice] = useState<PreparedVoice>();
  // On-device recognition failed here once (Electron's usually does): don't try it again.
  const [speechBroken, setSpeechBroken] = useState(false);
  const session = useRef<VoiceSession | undefined>(undefined);
  /** The start waiting on the microphone, if any; aborting it means nothing records. */
  const starting = useRef<AbortController | undefined>(undefined);
  const pressedAt = useRef(0);
  /** A pointer is down on the mic (and captured by it). */
  const held = useRef(false);
  const speech = hasSpeechRecognition() && !speechBroken;
  /** Nothing here turns speech into words yet: a press offers a way first. */
  const needsSetup = !speech && props.transcriptionModel === undefined;
  const [setup, setSetup] = useState(false);
  const available = canRecordVoice();
  useEffect(
    () => () => {
      starting.current?.abort();
      session.current?.cancel();
    },
    [],
  );

  const fail = (title: string, error?: unknown) =>
    toast.error({
      title,
      description: error instanceof Error ? error.message : undefined,
    });

  const start = async () => {
    if (needsSetup) return setSetup(true);
    // The person talking stops the bot talking.
    stopSpeaking();
    const controller = new AbortController();
    starting.current = controller;
    setState("starting");
    try {
      const started = await startVoice(speech, controller.signal);
      // Left, or let go, while the microphone was being asked for: nothing records.
      if (controller.signal.aborted) return started.cancel();
      session.current = started;
      setState("recording");
    } catch (error) {
      if (controller.signal.aborted) return;
      setState("idle");
      fail("Couldn't use the microphone", error);
    } finally {
      if (starting.current === controller) starting.current = undefined;
    }
  };

  /** A start still waiting on the microphone ends there, with nothing recorded. */
  const abandonStart = () => {
    const controller = starting.current;
    if (!controller) return;
    starting.current = undefined;
    controller.abort();
    setState("idle");
  };

  /** The press ended as a hold (or the pointer was taken away): stop whatever it began. */
  const endHold = () => {
    if (state === "starting") abandonStart();
    else if (state === "recording") void finish();
  };

  const finish = async () => {
    const running = session.current;
    if (!running) return;
    session.current = undefined;
    setState("transcribing");
    try {
      const take = await running.finish();
      if (take.recognitionBroken) setSpeechBroken(true);
      const { words, voice: prepared } = await wordsOf(take, (recording) =>
        props.transcriptionModel !== undefined
          ? transcribe(client, recording)
          : Promise.resolve(""),
      );
      if (!words) {
        // The device couldn't after all, and nothing else can yet: offer a way.
        if (take.recognitionBroken && props.transcriptionModel === undefined) setSetup(true);
        else fail("Couldn't make out any words");
        return;
      }
      props.onWords(words);
      setVoice(prepared);
    } catch (error) {
      fail("Couldn't turn the recording into words", error);
    } finally {
      setState("idle");
    }
  };

  return {
    available,
    state,
    voice,
    /** On-device recognition is worth trying here. */
    recognize: speech,
    /** No way to turn speech into words yet. */
    needsSetup,
    /** The way-to-transcribe choice is open above the composer. */
    setup,
    openSetup: () => setSetup(true),
    closeSetup: () => setSetup(false),
    remove: () => setVoice(undefined),
    /** Pointer handlers and keys for the mic button. */
    press(event: PointerEvent<HTMLButtonElement>) {
      if (event.button !== 0) return;
      event.preventDefault();
      // The release comes here even if the pointer leaves the mic while held.
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // No pointer to capture (a synthetic event): the release still lands on the mic.
      }
      held.current = true;
      pressedAt.current = event.timeStamp;
      if (state === "recording") void finish();
      else if (state === "idle") void start();
    },
    lift(event: PointerEvent<HTMLButtonElement>) {
      if (!held.current) return;
      held.current = false;
      // A tap leaves it starting or recording until the next press; a hold ends with the release.
      if (event.timeStamp - pressedAt.current >= holdMs) endHold();
    },
    /** The press was taken away (`pointercancel`, or capture lost while held): a stop. */
    lose() {
      if (!held.current) return;
      held.current = false;
      endHold();
    },
    key(event: KeyboardEvent<HTMLButtonElement>) {
      if ((event.key !== " " && event.key !== "Enter") || event.repeat) return;
      event.preventDefault();
      if (state === "recording") void finish();
      else if (state === "idle") void start();
    },
  };
}

export type SpadeVoiceInput = ReturnType<typeof useSpadeVoice>;

/** A round composer control, the size of the composer's others. */
const round = "size-(--composer-control) rounded-full";

/** The mic, just before the composer's filled button: the platform's own control, so a glyph. */
export function MicButton(props: { voice: SpadeVoiceInput }) {
  const { voice } = props;
  if (!voice.available) return null;
  const recording = voice.state === "recording";
  return (
    <IconButton
      icon={MicrophoneIcon}
      label={recording ? "Stop recording" : "Record a voice message"}
      tip={recording ? "Stop recording" : "Hold to record"}
      pressed={recording}
      className={round}
      // Not disabled while starting: the release that ends a hold must still arrive.
      disabled={voice.state === "transcribing"}
      onPointerDown={voice.press}
      onPointerUp={voice.lift}
      onPointerCancel={voice.lose}
      onLostPointerCapture={voice.lose}
      onKeyDown={voice.key}
    />
  );
}

/**
 * The strip above the composer while recording, transcribing, choosing a way to transcribe, or
 * with a recording attached.
 */
export function VoiceStrip(props: { voice: SpadeVoiceInput }) {
  const { voice } = props;
  if (voice.setup)
    return <TranscriptionSetup onChosen={voice.closeSetup} onClose={voice.closeSetup} />;
  if (voice.state === "recording" || voice.state === "transcribing")
    return (
      <StripSurface slot="voice" variant={voice.state}>
        <div role="status" className="flex h-7 min-w-0 items-center gap-1.5 px-1 text-xs">
          {voice.state === "transcribing" && <Spinner />}
          <span className="min-w-0 truncate text-foreground">
            {voice.state === "recording" ? "Recording" : "Turning it into words…"}
          </span>
        </div>
      </StripSurface>
    );
  if (!voice.voice) return null;
  return (
    <StripSurface slot="voice" variant="attached">
      <div className="flex h-7 min-w-0 items-center gap-1.5 px-1 text-xs">
        <span className="min-w-0 flex-1 truncate text-foreground">Voice message attached</span>
        <Button size="xs" variant="ghost" onClick={voice.remove}>
          Remove
        </Button>
      </div>
    </StripSurface>
  );
}

/**
 * The filled button at the composer's end while the field is empty: a spoken conversation with
 * the bot, hands free. Pressed again, it ends. Without a way to turn speech into words yet, it
 * offers one first.
 */
export function VoiceButton(props: { name: string; talk: TalkMode; voice: SpadeVoiceInput }) {
  const { talk, voice } = props;
  const on = talk.state.kind !== "off";
  if (!voice.available)
    return (
      <IconButton
        icon={WaveformIcon}
        label={`Talk with ${props.name}`}
        disabled
        reason="This device can't record"
        className={filled}
      />
    );
  return (
    <IconButton
      icon={WaveformIcon}
      label={on ? `End the conversation with ${props.name}` : `Talk with ${props.name}`}
      tip={on ? "End" : "Talk hands free"}
      pressed={on}
      className={filled}
      onClick={() => (on ? talk.end() : voice.needsSetup ? voice.openSetup() : talk.start())}
    />
  );
}

const filled = `${round} bg-tint text-tint-foreground hover:bg-tint hover:text-tint-foreground`;

/**
 * The one quiet line above the composer while a spoken conversation lasts: where it is, in
 * words, and End. Nothing tinted: the words say it.
 */
export function TalkLine(props: { name: string; talk: TalkMode; push: boolean }) {
  const line = talkLine(props.talk.state, props.name);
  if (!line) return null;
  const stop =
    props.talk.state.kind === "speaking"
      ? " · Esc to stop"
      : props.talk.state.kind === "listening" && props.push
        ? " · it sends when you stop talking"
        : "";
  return (
    <p
      role="status"
      aria-live="polite"
      className="mb-2 flex flex-wrap items-center justify-center gap-x-1 px-1 text-ui text-muted-foreground"
    >
      <span>{`${line}${stop}`}</span>
      <Button size="xs" variant="ghost" onClick={props.talk.end}>
        End
      </Button>
    </p>
  );
}

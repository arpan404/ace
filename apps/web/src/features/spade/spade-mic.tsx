import { MicrophoneIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { StripSurface } from "@/features/thread/index.ts";
import { prepareSpadeVoice, type PreparedVoice } from "./spade-attachments.ts";
import { transcribe } from "./spade-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";
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
 * Without either way to turn speech into words, there is no mic.
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
  const available = canRecordVoice() && (speech || props.transcriptionModel !== undefined);
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
      const prepared = await prepareSpadeVoice(take.recording);
      const words =
        take.heard ||
        (props.transcriptionModel !== undefined ? (await transcribe(client, prepared)).trim() : "");
      if (!words) {
        fail(
          take.recognitionBroken && props.transcriptionModel === undefined
            ? "Couldn't turn speech into words here. Choose a transcription model in Settings › Spade."
            : "Couldn't make out any words",
        );
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

/** The mic, beside + in the composer's footer: the platform's own control, so a glyph. */
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

/** The strip above the composer while recording, transcribing, or with a recording attached. */
export function VoiceStrip(props: { voice: SpadeVoiceInput }) {
  const { voice } = props;
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

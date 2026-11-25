import type { SpadeVoiceRef } from "@ace/ui-core/spade-chat";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { holdSpadeRecording } from "./spade-images.ts";
import { useSpadeClient } from "./spade-machine.tsx";

/*
 * What a message carries besides words, in the chat (ADR 0134): pictures, documents and a voice
 * message's recording. Each is read from Spade by hash only when shown or asked for.
 */

/** A voice message's recording: Play and Pause, read from Spade on the first Play. */
export function VoicePlay(props: { voice: SpadeVoiceRef }) {
  const client = useSpadeClient();
  const toast = useToast();
  const audio = useRef<HTMLAudioElement>(null);
  const held = useRef<ReturnType<typeof holdSpadeRecording> | undefined>(undefined);
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  useEffect(() => () => held.current?.release(), []);
  const toggle = async () => {
    const element = audio.current;
    if (!element) return;
    if (state === "playing") {
      element.pause();
      return;
    }
    setState("loading");
    try {
      held.current ??= holdSpadeRecording(client, props.voice.sha256);
      const url = await held.current.url;
      if (element.src !== url) element.src = url;
      await element.play();
    } catch (error) {
      setState("idle");
      toast.error({
        title: "Couldn't play the voice message",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };
  return (
    <>
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- the transcript is the bubble's words */}
      <audio
        ref={audio}
        hidden
        onPlaying={() => setState("playing")}
        onPause={() => setState("idle")}
        onEnded={() => setState("idle")}
      />
      <Button
        size="xs"
        variant="ghost"
        aria-label={state === "playing" ? "Pause voice message" : "Play voice message"}
        disabled={state === "loading"}
        onClick={() => void toggle()}
      >
        {state === "playing" ? "Pause" : "Play"}
      </Button>
    </>
  );
}

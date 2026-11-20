import type { SpadeEntry } from "@ace/ui-core/spade-chat";
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useSpadeClient } from "./spade-machine.tsx";
import {
  onSpeechTrouble,
  speakTurn,
  stopReadingOf,
  type LiveSpeech,
  type SpeechVoice,
} from "./spade-speech.ts";
import { spokenReply, type SpokenReply } from "./spade-spoken-reply.ts";
import { botVoice, useVoicePrefs } from "./spade-voice-prefs.ts";
import { useSpadeModels } from "./use-spade-models.ts";

/*
 * Spoken replies (ADR 0134, amended): while "Speak replies" is on for a bot, or right after the
 * person spoke their message from this window, the bot's next reply is read aloud as it is
 * written, sentence by sentence. History is never read: only a reply still being written while
 * the chat is on screen.
 */

/** The voice a bot speaks in here, for Read aloud in its bubbles. */
export const BotVoiceContext = createContext<SpeechVoice | undefined>(undefined);

export function useBotVoiceContext(): SpeechVoice | undefined {
  return useContext(BotVoiceContext);
}

/** `machine/bot`: where a bot's voice choices are kept. */
export const voiceKey = (machine: string, bot: string) => `${machine}/${bot}`;

/** The voice a bot speaks in on this device, and whether its replies are spoken. */
export function useBotSpeech(machine: string, bot: string) {
  const client = useSpadeClient();
  const prefs = useVoicePrefs();
  const speechModel = useSpadeModels(true).data?.speechModel;
  const choice = botVoice(prefs, voiceKey(machine, bot));
  const voice = useMemo<SpeechVoice>(
    () =>
      speechModel
        ? { engine: "endpoint", voice: choice.endpointVoice, target: client }
        : { engine: "system", voice: choice.systemVoice },
    [speechModel, choice.endpointVoice, choice.systemVoice, client],
  );
  return { voice, speakReplies: choice.speakReplies };
}

/** A reply's words so far: each step's text, then the open step's. */
function replyWords(entry: Extract<SpadeEntry, { kind: "reply" }>): string {
  const words = entry.parts.flatMap((part) => (part.kind === "text" ? [part.text] : []));
  if (entry.live) words.push(entry.live);
  return words.join("\n\n");
}

interface Speaking {
  reply: string;
  turn: LiveSpeech;
  reader: SpokenReply;
}

/**
 * Speaks the conversation's replies as they stream, when asked. `arm()` says the next reply
 * answers something the person said aloud.
 */
export function useSpokenReplies(props: {
  conversation: string;
  entries: readonly SpadeEntry[];
  caughtUp: boolean;
  voice: SpeechVoice;
  speakReplies: boolean;
}) {
  const toast = useToast();
  const armed = useRef(false);
  const speaking = useRef<Speaking | undefined>(undefined);
  /** Replies already there when the chat opened, or already spoken: never read again. */
  const heard = useRef<Set<string> | undefined>(undefined);
  const key = `spoken:${props.conversation}`;

  useEffect(
    () =>
      onSpeechTrouble((error) =>
        toast.error({
          title: "Couldn't read the reply aloud",
          description: error instanceof Error ? error.message : undefined,
        }),
      ),
    [toast],
  );
  useEffect(() => () => stopReadingOf(key), [key]);

  const latest = props.entries.findLast((entry) => entry.kind === "reply");
  useEffect(() => {
    if (!props.caughtUp) return;
    // Finished replies are history; one still being written when the chat opens is live.
    const replies = props.entries.flatMap((entry) =>
      entry.kind === "reply" && entry.end ? [entry.reply] : [],
    );
    if (!heard.current) {
      heard.current = new Set(replies);
      return;
    }
    if (!latest) return;
    const current = speaking.current;
    if (current?.reply !== latest.reply) {
      if (heard.current.has(latest.reply)) return;
      heard.current.add(latest.reply);
      if (!armed.current && !props.speakReplies) return;
      armed.current = false;
      speaking.current = {
        reply: latest.reply,
        turn: speakTurn(key, props.voice),
        reader: spokenReply(),
      };
    }
    const now = speaking.current;
    if (!now) return;
    const words = replyWords(latest);
    if (latest.end) {
      now.turn.add(latest.end.kind === "finished" ? now.reader.finish(words) : []);
      now.turn.close();
      speaking.current = undefined;
    } else now.turn.add(now.reader.push(words));
  });

  return {
    /** The next reply answers words the person spoke: read it aloud. */
    arm() {
      armed.current = true;
    },
  };
}

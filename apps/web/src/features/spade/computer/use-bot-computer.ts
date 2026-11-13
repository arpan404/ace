import { parseSpadeComputerBody, type SpadeComputer } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { coworkState } from "@ace/ui-core/cowork";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import type { ConversationFollow } from "../conversation-follow.ts";
import { message } from "../spade-screen-parts.tsx";
import { useSpadeClient } from "../spade-machine.tsx";
import { agentsKey, type RosterBot } from "../use-spade-roster.ts";
import { handBack, readComputer, takeOver } from "./computer-api.ts";

/**
 * A bot's computer as it is now. What it shows comes from the conversation stream's `computer`
 * frames (sent on connect and on every change), else the roster's last read. In cowork (the
 * default) the person and the bot use it at once: the person's input goes in straight away and
 * the bot yields to it. In exclusive mode (Take over) the controls are the person's only while that stream is up and the latest state from Spade says they drive and
 * the bot's work has stopped: never from Take over's own answer, never while a take-over or
 * hand-back is on its way, and never while the stream is down. Take over and Hand back read the
 * computer from Spade once answered; that read counts only if nothing newer (a frame, the stream
 * dropping) came while it was out.
 */
export function useBotComputer(
  bot: RosterBot,
  side: Pick<ConversationFollow, "onSide" | "onEnded"> | undefined,
) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  /** The latest state Spade sent, by frame or read. */
  const [live, setLive] = useState<SpadeComputer>();
  /** The stream that sends the frames is up: it sent one since it last ended. */
  const [streamUp, setStreamUp] = useState(false);
  /** Bumps on every frame and every end of the stream: a read started before is stale. */
  const generation = useRef(0);
  const [pending, setPending] = useState<"take-over" | "hand-back">();
  useEffect(() => {
    if (!side) return;
    const stopFrames = side.onSide("computer", (data) => {
      const computer = parseSpadeComputerBody(data);
      if (!computer) return;
      generation.current++;
      setLive(computer);
      setStreamUp(true);
      // The list's row shows what it uses too: read it again now rather than at the next poll.
      void cache.invalidateQueries({ queryKey: agentsKey });
    });
    // The stream went: what it said may be out of date until it is back and says it again.
    const stopEnds = side.onEnded(() => {
      generation.current++;
      setStreamUp(false);
    });
    return () => {
      stopFrames();
      stopEnds();
    };
  }, [side, cache]);
  const computer = live ?? bot.computer;
  const act = (kind: "take-over" | "hand-back") => {
    setPending(kind);
    const asked = kind === "take-over" ? takeOver(client, bot.id) : handBack(client, bot.id);
    void asked
      .then(() => {
        const started = generation.current;
        return readComputer(client, bot.id).then((now) => ({ now, started }));
      })
      .then(
        ({ now, started }) => {
          setPending(undefined);
          // Only if nothing newer arrived while it was out.
          if (generation.current === started) {
            generation.current++;
            setLive(now);
          }
          void cache.invalidateQueries({ queryKey: agentsKey });
        },
        (error: unknown) => {
          setPending(undefined);
          toast.error({
            title:
              kind === "take-over" ? "Couldn't take over" : `Couldn't hand back to ${bot.name}`,
            description: message(error),
          });
        },
      );
  };
  const person = computer?.driver === "person";
  const cowork = computer?.mode === "cowork";
  const driving = streamUp && pending === undefined && person && computer?.stopping === false;
  const agentActive = (computer?.surfaces ?? []).some((each) => each.live);
  const yielding = (computer?.surfaces ?? []).some((each) => each.live && each.personActive);
  return {
    computer,
    /**
     * Exclusive mode is the person's: the stream is up and Spade says they drive, work stopped.
     */
    driving,
    /** Cowork, as Spade last said: both use it, the bot yielding to the person. */
    cowork,
    /**
     * The person's input goes in now: in cowork straight away (unless a take-over is on its
     * way), in exclusive mode only while they drive.
     */
    mayAct: driving || (cowork && !person && pending === undefined),
    /** Who has it now, for the one-line status. */
    status: coworkState({
      exclusive: person || pending === "take-over",
      personActive: cowork && yielding,
      agentActive,
    }),
    /** The person has the computer (or is getting it) and the bot's work is still stopping. */
    stopping: (person && computer?.stopping === true) || pending === "take-over",
    /** The person has the computer, as Spade last said: the bot is paused. */
    paused: person,
    pending,
    takeOver: () => act("take-over"),
    handBack: () => act("hand-back"),
  };
}

export type BotComputerState = ReturnType<typeof useBotComputer>;

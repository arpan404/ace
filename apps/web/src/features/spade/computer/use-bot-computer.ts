import { parseSpadeComputerBody, type SpadeComputer } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import type { ConversationFollow } from "../conversation-follow.ts";
import { message } from "../spade-screen-parts.tsx";
import { useSpadeClient } from "../spade-machine.tsx";
import { agentsKey, type RosterBot } from "../use-spade-roster.ts";
import { handBack, takeOver } from "./computer-api.ts";

/**
 * A bot's computer as it is now: from its conversation stream's `computer` frames (sent on
 * connect and on every change) once one arrived, else from the roster's last read. Take over and
 * Hand back say so at once and are corrected by the next frame.
 */
export function useBotComputer(
  bot: RosterBot,
  side: Pick<ConversationFollow, "onSide"> | undefined,
) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const [live, setLive] = useState<SpadeComputer>();
  const [pending, setPending] = useState<"take-over" | "hand-back">();
  useEffect(
    () =>
      side?.onSide("computer", (data) => {
        const computer = parseSpadeComputerBody(data);
        if (computer) setLive(computer);
      }),
    [side],
  );
  const computer = live ?? bot.computer;
  const act = (kind: "take-over" | "hand-back") => {
    setPending(kind);
    void (kind === "take-over" ? takeOver : handBack)(client, bot.id).then(
      () => {
        setPending(undefined);
        setLive((shown) => ({
          threadId: undefined,
          surfaces: [],
          ...(shown ?? bot.computer),
          driver: kind === "take-over" ? "person" : "bot",
        }));
        void cache.invalidateQueries({ queryKey: agentsKey });
      },
      (error: unknown) => {
        setPending(undefined);
        toast.error({
          title: kind === "take-over" ? "Couldn't take over" : `Couldn't hand back to ${bot.name}`,
          description: message(error),
        });
      },
    );
  };
  return {
    computer,
    /** The person drives: the bot is paused. */
    driving: computer?.driver === "person",
    pending,
    takeOver: () => act("take-over"),
    handBack: () => act("hand-back"),
  };
}

export type BotComputerState = ReturnType<typeof useBotComputer>;

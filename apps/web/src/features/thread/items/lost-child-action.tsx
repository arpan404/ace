import { useCallback } from "react";
import { useInteraction, useInteractions } from "@ace/client-react";
import type { Interaction } from "@ace/protocol";
import { lostChildAsk, lostChildOf } from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";
import { useAnswerSender } from "../interactions/answer-sender.ts";

/** The parent's open request about this child on another machine, which the daemon names. */
function useLostAsk(threadId: string, childThreadId: string) {
  const about = useCallback(
    (interaction: Interaction) => lostChildOf(interaction) === childThreadId,
    [childThreadId],
  );
  const [id] = useInteractions(threadId, about) ?? [];
  return useInteraction(threadId, id ?? "");
}

/**
 * Under a child whose pairing is gone (ADR 0099): one sentence saying its work there may still
 * be running, and Stop tracking, which answers the same request the composer strip shows.
 */
export function LostChildAction(props: { threadId: string; childThreadId: string }) {
  const ask = useLostAsk(props.threadId, props.childThreadId);
  const { answer, failed } = useAnswerSender({
    interactionId: ask?.id ?? "",
    identity: undefined,
    questions: [],
  });
  const lost = ask ? lostChildAsk(ask) : undefined;
  if (!lost) return null;
  return (
    <div className="flex min-w-0 items-baseline gap-2 pl-7 text-xs">
      <p className="min-w-0 flex-1 text-muted-foreground">{failed ?? lost.sentence}</p>
      <Button
        variant="ghost"
        size="xs"
        aria-label={lost.label}
        onClick={() => answer({ kind: "approval", optionId: lost.optionId })}
      >
        {lost.action}
      </Button>
    </div>
  );
}

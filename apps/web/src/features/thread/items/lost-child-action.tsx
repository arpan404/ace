import { useCallback } from "react";
import { useInteraction, useInteractions } from "@ace/client-react";
import type { Interaction } from "@ace/protocol";
import { lostChildOf } from "@ace/ui-core";
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
  const request = ask?.state === "pending" && ask.request.kind === "approval" ? ask.request : null;
  const option = request?.options[0];
  if (!request || !option) return null;
  return (
    <div className="flex min-w-0 items-baseline gap-2 pl-7 text-xs">
      <p className="min-w-0 flex-1 text-muted-foreground">{failed ?? request.title}</p>
      <Button
        variant="ghost"
        size="xs"
        aria-label={option.label}
        onClick={() => answer({ kind: "approval", optionId: option.id })}
      >
        Stop tracking
      </Button>
    </div>
  );
}

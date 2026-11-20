import {
  spadeConnectedWords,
  type SpadeBubble,
  type SpadeConnectAsk,
} from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { AppMark } from "@/components/ui/app-mark.tsx";
import { cn } from "@/lib/cn.ts";
import { SpadeBubbleText } from "./spade-bubble-text.tsx";
import { botBubble, LaterClock, settledLine } from "./spade-card.tsx";
import { ConnectAppCard } from "./spade-connect-card.tsx";
import type { QuestionReply } from "./use-spade-conversation.ts";

type Card = Extract<SpadeBubble, { kind: "question" }>;

/**
 * A connect card in the chat (ADR 0131 amendment 1, ADR 0154), where the bot asked. Waiting, the
 * raised `ConnectAppCard` with Later and Not now; left for later, one line with Connect, which
 * opens it again. Once connected it settles into one quiet line ("Connected as …"); an app that
 * isn't available yet says so in the bot's bubble, and nothing waits on it.
 */
export function SpadeConnectBubble(props: {
  item: Card;
  ask: SpadeConnectAsk;
  botName: string;
  onReply(callId: string, reply: QuestionReply): Promise<string | undefined>;
}) {
  const { item, ask } = props;
  const why = item.questions[0]?.prompt ?? "";
  const [opened, setOpened] = useState(false);
  const verb = ask.way === "reconnect" ? "Reconnect" : "Connect";
  if (item.standing === "deferred" && !opened)
    return (
      <div
        role="group"
        aria-label={`${props.botName} asks to use ${ask.name}`}
        data-question={item.callId}
        tabIndex={-1}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setOpened(true);
        }}
        className={cn(settledLine, "items-center rounded-sm focus-ring")}
      >
        <LaterClock />
        <span className="min-w-0 truncate">{`For later · ${verb} ${ask.name}`}</span>
        <button
          type="button"
          onClick={() => setOpened(true)}
          className="-mx-1 shrink-0 touch-hit rounded-sm px-1 font-medium text-foreground focus-ring hover:underline"
        >
          {verb}
        </button>
      </div>
    );
  if (item.standing === "waiting" || item.standing === "deferred")
    return (
      <ConnectAppCard
        ask={ask}
        why={why}
        botName={props.botName}
        callId={item.callId}
        onConnected={(connector, everyone) =>
          props.onReply(item.callId, { connected: connector, everyone })
        }
        onLater={
          item.standing === "deferred"
            ? () => setOpened(false)
            : () => void props.onReply(item.callId, { defer: true })
        }
        onNotNow={() => void props.onReply(item.callId, { dismiss: true })}
      />
    );
  if (ask.way === "later")
    return (
      <div
        role="group"
        aria-label={`${ask.name} isn't available yet`}
        data-question={item.callId}
        className={cn(botBubble, "flex flex-col gap-1.5")}
      >
        <span className="flex items-center gap-2 font-medium">
          <AppMark catalogue={ask.app} name={ask.name} size="inline" />
          {ask.name}
        </span>
        <SpadeBubbleText text={why} />
        <span className="text-ui text-muted-foreground">Not available yet</span>
      </div>
    );
  const answer = item.standing === "answered" ? item.answers?.[0] : undefined;
  const settled =
    answer !== undefined
      ? spadeConnectedWords(ask, answer)
      : item.standing === "answered"
        ? "Answered in the chat"
        : `Not connected · ${ask.name}`;
  return (
    <p
      data-question={item.callId}
      className={cn(settledLine, "items-center text-subtle-foreground")}
    >
      <AppMark catalogue={ask.app} name={ask.name} size="inline" />
      <span className="min-w-0 truncate">{settled}</span>
    </p>
  );
}

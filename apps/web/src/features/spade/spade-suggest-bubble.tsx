import { parseStoredBotFace } from "@ace/ui-core/bot-face";
import {
  spadeInstalledWords,
  type SpadeBubble,
  type SpadeSuggestAsk,
} from "@ace/ui-core/spade-chat";
import { useMemo, useState } from "react";
import { BotFace } from "@/components/bot-face.tsx";
import { cn } from "@/lib/cn.ts";
import { useOpenMarket } from "@/lib/open-market.ts";
import { SpadeBubbleText } from "./spade-bubble-text.tsx";
import {
  CardBody,
  CardFooter,
  CardPrimary,
  CardWord,
  LaterClock,
  NeedsYouLine,
  RaisedCard,
  settledLine,
} from "./spade-card.tsx";
import type { QuestionReply } from "./use-spade-conversation.ts";

type Card = Extract<SpadeBubble, { kind: "question" }>;

/** The `?market=` value of the package's install review (`market-address.ts`). */
export const suggestReviewAddress = (ask: SpadeSuggestAsk) =>
  `bot/${ask.package}${ask.source === "market" ? "" : `@${ask.source}`}/review`;

function Face(props: { ask: SpadeSuggestAsk; size: number }) {
  const face = useMemo(() => parseStoredBotFace(props.ask.face)?.face, [props.ask.face]);
  if (!face) return null;
  return <BotFace face={face} size={props.size} className="shrink-0" />;
}

/**
 * A bot suggesting a package (ADR 0200 §8), where it suggested it: a raised card with the
 * package's face, name and publisher (from the market's signed manifest), its one line, the
 * bot's reason and what it would be allowed to do. Review install opens the Marketplace's normal
 * install review, with its switches; nothing installs without it, and the bot can't install
 * anything. Later folds the card to one line; Not now tells the bot no. Installed, it settles
 * to one quiet line.
 */
export function SpadeSuggestBubble(props: {
  item: Card;
  ask: SpadeSuggestAsk;
  botName: string;
  onReply(callId: string, reply: QuestionReply): Promise<string | undefined>;
}) {
  const { item, ask } = props;
  const why = item.questions[0]?.prompt ?? "";
  const [opened, setOpened] = useState(false);
  const open = useOpenMarket();
  const review = () => open(suggestReviewAddress(ask));
  if (item.standing === "deferred" && !opened)
    return (
      <div
        role="group"
        aria-label={`${props.botName} suggests ${ask.name}`}
        data-question={item.callId}
        tabIndex={-1}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setOpened(true);
        }}
        className={cn(settledLine, "items-center rounded-sm focus-ring")}
      >
        <LaterClock />
        <span className="min-w-0 truncate">{`For later · Install ${ask.name}`}</span>
        <button
          type="button"
          onClick={() => setOpened(true)}
          className="-mx-1 shrink-0 touch-hit rounded-sm px-1 font-medium text-foreground focus-ring hover:underline"
        >
          Review
        </button>
      </div>
    );
  if (item.standing === "waiting" || item.standing === "deferred")
    return (
      <RaisedCard
        asks="question"
        role="group"
        aria-label={`${props.botName} suggests ${ask.name}`}
        data-question={item.callId}
        tabIndex={-1}
      >
        <NeedsYouLine glyph="question">
          <div className="flex min-w-0 items-center gap-2.5">
            <Face ask={ask} size={32} />
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-medium text-foreground">{ask.name}</span>
              <span className="truncate text-ui text-muted-foreground">
                {`By ${ask.publisher.name} · ${props.botName} suggests it`}
              </span>
            </div>
          </div>
        </NeedsYouLine>
        <CardBody>
          {ask.blurb && <p className="text-ui text-muted-foreground">{ask.blurb}</p>}
          <SpadeBubbleText text={why} />
          {ask.can.length > 0 && (
            <div className="flex flex-col gap-0.5 text-ui text-muted-foreground">
              <span>It would ask to:</span>
              <ul className="list-disc pl-5">
                {ask.can.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs leading-4 text-subtle-foreground">
            {`Nothing is installed until you review it. ${props.botName} can't install it.`}
          </p>
        </CardBody>
        <CardFooter
          start={
            <>
              <CardWord
                onClick={
                  item.standing === "deferred"
                    ? () => setOpened(false)
                    : () => void props.onReply(item.callId, { defer: true })
                }
              >
                Later
              </CardWord>
              <CardWord onClick={() => void props.onReply(item.callId, { dismiss: true })}>
                Not now
              </CardWord>
            </>
          }
          end={<CardPrimary onClick={review}>Review install</CardPrimary>}
        />
      </RaisedCard>
    );
  const answer = item.standing === "answered" ? item.answers?.[0] : undefined;
  const settled =
    answer !== undefined
      ? spadeInstalledWords(ask, answer)
      : item.standing === "answered"
        ? "Answered in the chat"
        : `Not installed · ${ask.name}`;
  return (
    <p
      data-question={item.callId}
      className={cn(settledLine, "items-center text-subtle-foreground")}
    >
      <Face ask={ask} size={16} />
      <span className="min-w-0 truncate">{settled}</span>
    </p>
  );
}

import { spadeAppOfTool, spadeAppRequestGroup, type SpadeBubble } from "@ace/ui-core/spade-chat";
import { useRef, useState } from "react";
import { Kbd } from "@/components/ui/kbd.tsx";
import { AppMark } from "@/components/ui/app-mark.tsx";
import { useAppAlways } from "./spade-app-always.tsx";
import {
  CardBody,
  CardFooter,
  CardPrimary,
  CardWhy,
  CardWord,
  NeedsYouLine,
  RaisedCard,
  cardKeyHint,
} from "./spade-card.tsx";
import { useSpadeConnectors } from "./spade-connector-api.ts";
import type { RequestAnswer } from "./spade-request-bubble.tsx";
import { ApproversLine } from "./spade-shared-lines.tsx";
import { useCardFocus } from "./use-card-focus.ts";

type Ask = Extract<SpadeBubble, { kind: "ask" }>;

/**
 * Requests one connected app's tools made together, as one card (ADR 0202, amendment 5): one
 * sentence ("Quill wants to do 3 things in Notion"), the calls listed quietly under it, the
 * reason once when they share it, then Deny and Allow for all of them, and "Always allow for
 * Notion" where every one of them offers it. Enter allows all, Escape denies all.
 */
export function SpadeRequestGroup(props: {
  items: readonly Ask[];
  botId: string;
  botName: string;
  onAnswer(callId: string, answer: RequestAnswer): Promise<boolean>;
}) {
  const { items } = props;
  const first = items[0];
  const connection = first ? spadeAppOfTool(first.name)?.connection : undefined;
  const connector = useSpadeConnectors().data?.connectors.find((each) => each.id === connection);
  const app = connector?.name ?? "the app";
  const who = first?.helper ? `A helper of ${props.botName}` : props.botName;
  const words = spadeAppRequestGroup(
    who,
    app,
    items.map((item) => ({
      tool: spadeAppOfTool(item.name)?.tool ?? item.name,
      arguments: item.arguments,
    })),
  );
  const reasons = new Set(items.map((item) => item.reason));
  const [reason] = reasons;
  const always = useAppAlways(props.botId);
  const forApp =
    connection !== undefined && items.every((item) => item.ask === "app" && item.app === connection)
      ? connection
      : undefined;
  const [answering, setAnswering] = useState<RequestAnswer>();
  const raised = useRef<HTMLDivElement>(null);
  useCardFocus(raised, 0);
  const answerAll = (choice: RequestAnswer, again = false) => {
    if (answering !== undefined && !again) return;
    setAnswering(choice);
    void Promise.all(items.map((item) => props.onAnswer(item.callId, choice))).then((sent) => {
      if (!sent.every(Boolean)) setAnswering(undefined);
    });
  };
  const allowAlways = () => {
    if (!forApp || answering !== undefined) return;
    setAnswering("always");
    void always
      .allow(forApp, () => answerAll("allow", true))
      .then((made) => {
        if (!made) setAnswering(undefined);
      });
  };
  const named = words.sentence.replace(/[.?]$/, "");
  return (
    <RaisedCard
      ref={raised}
      asks="request"
      data-request-group={connection}
      role="group"
      aria-label={named}
      // Focusable while open, so Enter and Escape answer it from the keyboard.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          answerAll("deny");
        } else if (event.key === "Enter" && event.target === event.currentTarget) {
          event.preventDefault();
          answerAll("allow");
        }
      }}
    >
      <NeedsYouLine glyph="request">
        <p>
          {connector && (
            <AppMark
              catalogue={connector.catalogue}
              name={connector.name}
              size="inline"
              className="mr-1.5 inline-grid align-[-0.3em]"
            />
          )}
          {words.sentence}
        </p>
      </NeedsYouLine>
      <CardBody>
        <ul aria-label="Calls" className="flex flex-col gap-0.5 text-ui text-muted-foreground">
          {words.lines.map((line, index) => (
            <li key={items[index]?.callId ?? index} className="wrap-anywhere">
              {line}
            </li>
          ))}
        </ul>
        {reasons.size === 1 && reason && <CardWhy>{reason}</CardWhy>}
        {always.prompt}
      </CardBody>
      <ApproversLine botId={props.botId} />
      <CardFooter
        start={
          <>
            {forApp && (
              <CardWord disabled={answering !== undefined} onClick={allowAlways}>
                {answering === "always" ? "Allowing…" : `Always allow for ${app}`}
              </CardWord>
            )}
            <CardWord disabled={answering !== undefined} onClick={() => answerAll("deny")}>
              {answering === "deny" ? "Denying…" : "Deny all"}
            </CardWord>
          </>
        }
        end={
          <CardPrimary disabled={answering !== undefined} onClick={() => answerAll("allow")}>
            {answering === "allow" ? "Allowing…" : "Allow all"}
            <Kbd
              aria-hidden
              keys="enter"
              resolve={false}
              variant="on-primary"
              className={cardKeyHint}
            />
          </CardPrimary>
        }
      />
    </RaisedCard>
  );
}

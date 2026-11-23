import { useTaskTitle } from "./lanes/lanes-context.ts";
import {
  spadeAppOfTool,
  spadeAppRequestGroup,
  type SpadeAppCallLine,
  type SpadeBubble,
} from "@ace/ui-core/spade-chat";
import { Button } from "@/components/ui/button.tsx";
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
 * Requests one connected app's tools made together, of one gate kind, as one card (ADR 0202,
 * amendment 5), one request alone too: one sentence headed by what the gate read them as doing ("Quill wants to make 3
 * changes in Notion"), never by the tools' names, then each call with where it goes and the
 * gate's reason, its full arguments a tap away (Details) before anything is allowed. Deny all and
 * Allow all answer each; "Always allow for Notion" shows only where every call is an ordinary
 * write Spade offers it for, and covers those tools as shown. Enter allows all, Escape denies.
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
  const task = useTaskTitle(first?.lane);
  const who = task ? task : first?.helper ? `A helper of ${props.botName}` : props.botName;
  const words = spadeAppRequestGroup(
    who,
    app,
    items.map((item) => ({
      tool: spadeAppOfTool(item.name)?.tool ?? item.name,
      arguments: item.arguments,
      effect: item.effect,
      ask: item.ask,
      reason: item.reason,
    })),
  );
  const reasons = new Set(items.map((item) => item.reason));
  const [reason] = reasons;
  const shared = reasons.size === 1 ? reason : undefined;
  const always = useAppAlways(props.botId);
  const forApp =
    connection !== undefined &&
    items.every((item) => item.ask === "app" && item.app === connection && item.definition)
      ? connection
      : undefined;
  const tools = Object.fromEntries(items.map((item) => [item.name, item.definition ?? ""]));
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
      .allow(forApp, tools, () => answerAll("allow", true))
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
        <ul aria-label="Calls" className="flex flex-col gap-1.5 text-ui">
          {words.lines.map((line, index) => {
            const item = items[index];
            return (
              <CallLine
                key={item?.callId ?? index}
                line={line}
                arguments={item?.arguments}
                // A reason every call shares is said once, under the list.
                showReason={shared === undefined}
              />
            );
          })}
        </ul>
        {shared && <CardWhy>{shared}</CardWhy>}
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
              {answering === "deny" ? "Denying…" : items.length > 1 ? "Deny all" : "Deny"}
            </CardWord>
          </>
        }
        end={
          <CardPrimary disabled={answering !== undefined} onClick={() => answerAll("allow")}>
            {answering === "allow" ? "Allowing…" : items.length > 1 ? "Allow all" : "Allow"}
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

/**
 * One call on the card: what it does, where it goes, the gate's reason when calls differ, and
 * Details, which opens its full arguments (nested values included) in place.
 */
function CallLine(props: { line: SpadeAppCallLine; arguments: unknown; showReason: boolean }) {
  const { line } = props;
  const [open, setOpen] = useState(false);
  const named = line.subject ? `${line.text} “${line.subject}”` : line.text;
  const label = line.target ? `${named} · ${line.target}` : named;
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 wrap-anywhere text-muted-foreground">{label}</span>
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={open}
          aria-label={`Details of ${label}`}
          onClick={() => setOpen((shown) => !shown)}
        >
          {open ? "Hide" : "Details"}
        </Button>
      </div>
      {props.showReason && line.reason && (
        <p className="text-xs text-subtle-foreground">{line.reason}</p>
      )}
      {open && (
        <pre
          aria-label={`Arguments of ${label}`}
          className="no-scrollbar max-h-64 overflow-auto rounded-lg bg-chat-well px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere"
        >
          {JSON.stringify(props.arguments ?? {}, null, 2)}
        </pre>
      )}
    </li>
  );
}

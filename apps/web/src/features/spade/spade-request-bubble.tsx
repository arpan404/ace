import {
  spadeAskedAgain,
  spadeRequestCard,
  type SpadeBubble,
  type SpadeRequestDetail,
} from "@ace/ui-core/spade-chat";
import { Kbd } from "@/components/ui/kbd.tsx";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { useSpadeConnectors } from "./spade-connector-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import {
  CardBody,
  cardKeyHint,
  CardFooter,
  CardPrimary,
  CardWord,
  NeedsYouLine,
  RaisedCard,
} from "./spade-card.tsx";
import { readNotes } from "./spade-notes-api.ts";
import { notesKey } from "./spade-notes.tsx";

type Ask = Extract<SpadeBubble, { kind: "ask" }>;

const code =
  "no-scrollbar overflow-auto rounded-lg bg-chat-well px-3 py-2 font-mono text-ui leading-5 whitespace-pre-wrap wrap-anywhere";
/** Past this much the detail folds to a few lines, with Show all to open it in place. */
const longChars = 280;
const longLines = 6;

const isLong = (text: string) => text.length > longChars || text.split("\n").length > longLines;

/** The answers Spade takes: allow once, allow always, or deny. */
export type RequestAnswer = "allow" | "always" | "deny";

/**
 * A call the bot wants to make, as its card where it asked (ADR 0127). Open, it is raised: one
 * sentence in Spade's words, the reviewer's reason as one quiet line, the detail that matters for
 * that kind of call (folded when long), then, where the gate keeps it, Always allow, and Deny on
 * the left and Allow on the right. Asked again after the auto-review refused it (ADR 0163), it
 * says so ("… asks again to …") and opens with what was refused before. With focus on it, Enter
 * allows and Escape denies. Once
 * answered it leaves the chat.
 */
export function SpadeRequestBubble(props: {
  item: Ask;
  botId: string;
  botName: string;
  /** Another bot's name by its id, for a message it would send. */
  nameOf(id: string): string | undefined;
  onAnswer(callId: string, answer: RequestAnswer): Promise<boolean>;
}) {
  const { item } = props;
  const who = item.helper ? `A helper of ${props.botName}` : props.botName;
  const title = useToolTitle();
  const noteText = useNoteText(item, props.botId);
  const card = spadeRequestCard(item.name, item.arguments, who, {
    title,
    noteText,
    botName: props.nameOf,
  });
  const [answering, setAnswering] = useState<RequestAnswer>();
  const answer = (choice: RequestAnswer) => {
    if (answering !== undefined) return;
    setAnswering(choice);
    void props.onAnswer(item.callId, choice).then((sent) => {
      if (!sent) setAnswering(undefined);
    });
  };
  // Asked again after a refusal: the card says so, and leads with the refusal.
  const again = spadeAskedAgain(card.sentence, item.reason);
  const sentence = again?.sentence ?? card.sentence;
  const reason = again ? `Refused before: ${again.before}` : item.reason;
  const named = sentence.replace(/\.$/, "");
  return (
    <RaisedCard
      asks="request"
      role="group"
      aria-label={named}
      // Focusable while open, so Enter and Escape answer it from the keyboard.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onKeyDown={(event) => {
        // Escape anywhere in it denies; Enter on the card itself allows (a button's own Enter
        // presses that button).
        if (event.key === "Escape") {
          event.preventDefault();
          answer("deny");
        } else if (event.key === "Enter" && event.target === event.currentTarget) {
          event.preventDefault();
          answer("allow");
        }
      }}
    >
      <NeedsYouLine glyph="request">
        <p>{sentence}</p>
      </NeedsYouLine>
      {(reason || card.detail) && (
        <CardBody>
          {reason && <p className="text-ui leading-5 text-muted-foreground">{reason}</p>}
          {card.detail && <Detail detail={card.detail} />}
        </CardBody>
      )}
      <CardFooter
        start={
          <>
            {card.always && (
              <CardWord disabled={answering !== undefined} onClick={() => answer("always")}>
                {answering === "always" ? "Allowing…" : "Always allow"}
              </CardWord>
            )}
            <CardWord disabled={answering !== undefined} onClick={() => answer("deny")}>
              {answering === "deny" ? "Denying…" : "Deny"}
            </CardWord>
          </>
        }
        end={
          <CardPrimary disabled={answering !== undefined} onClick={() => answer("allow")}>
            {answering === "allow" ? "Allowing…" : "Allow"}
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

/** A connector's tool by its connector's name: `c1__create_event` → "Calendar create event". */
function useToolTitle() {
  const connectors = useSpadeConnectors().data?.connectors;
  return (name: string) => {
    const at = name.indexOf("__");
    if (at < 0) return undefined;
    const connector = connectors?.find((each) => each.id === name.slice(0, at));
    const tool = name
      .slice(at + 2)
      .replaceAll(/[_-]+/g, " ")
      .trim();
    return connector ? `${connector.name} ${tool}` : undefined;
  };
}

/** The note a memory call would change, read while its request is open. */
function useNoteText(item: Ask, botId: string) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const changes = item.name === "memory_update" || item.name === "memory_forget";
  const notes = useQuery({
    queryKey: [...notesKey, machine, "request", item.callId],
    queryFn: async ({ signal }) => {
      const [own, shared] = await Promise.all([
        readNotes(client, { kind: "agent", agent: botId }, { signal }).catch(() => []),
        readNotes(client, { kind: "shared" }, { signal }).catch(() => []),
      ]);
      return [...own, ...shared];
    },
    enabled: changes && item.state === "open",
  });
  return (id: string) => notes.data?.find((note) => note.id === id)?.text;
}

/** What the call would do, as text in its own shape. */
function Detail(props: { detail: SpadeRequestDetail }) {
  const { detail } = props;
  switch (detail.kind) {
    case "command":
      return <Folded label="Command" text={detail.command} />;
    case "file":
      return (
        <div className="flex flex-col gap-2">
          <p className="font-mono text-ui wrap-anywhere text-muted-foreground">{detail.path}</p>
          {detail.text !== undefined && <Folded label="Content" text={detail.text} />}
          {detail.before !== undefined && <Folded label="Replaces" text={detail.before} />}
          {detail.after !== undefined && <Folded label="With" text={detail.after} />}
        </div>
      );
    case "note":
      return (
        <div className="flex flex-col gap-0.5 text-ui">
          {detail.before !== undefined && (
            <p className="text-muted-foreground line-through decoration-border">{detail.before}</p>
          )}
          <FoldedText text={detail.text} />
        </div>
      );
    case "email":
      return (
        <div className="flex flex-col gap-0.5 text-ui">
          {detail.to && <Line label="To" value={detail.to} />}
          {detail.subject && <Line label="Subject" value={detail.subject} />}
          {detail.body && <FoldedText text={detail.body} muted />}
        </div>
      );
    case "message":
      return (
        <div className="flex flex-col gap-0.5 text-ui">
          <Line label="To" value={detail.to} />
          <FoldedText text={detail.text} muted />
        </div>
      );
    case "fields":
      return (
        <div className="flex flex-col gap-0.5 text-ui">
          {detail.fields.map((field) => (
            <Line key={field.label} label={field.label} value={field.value} />
          ))}
        </div>
      );
  }
}

function Line(props: { label: string; value: string }) {
  return (
    <p className="whitespace-pre-wrap wrap-anywhere">
      <span className="text-muted-foreground">{`${props.label}: `}</span>
      {props.value}
    </p>
  );
}

/** Code-like text in its block, a few lines of it until Show all. */
function Folded(props: { label: string; text: string }) {
  const long = isLong(props.text);
  const [all, setAll] = useState(false);
  return (
    <>
      <pre aria-label={props.label} className={cn(code, long && !all ? "max-h-28" : "max-h-96")}>
        {props.text}
      </pre>
      {long && <ShowAll all={all} onToggle={() => setAll((shown) => !shown)} />}
    </>
  );
}

/** Prose (a note, an email's words), clamped to a few lines until Show all. */
function FoldedText(props: { text: string; muted?: boolean }) {
  const long = isLong(props.text);
  const [all, setAll] = useState(false);
  return (
    <>
      <p
        className={cn(
          "whitespace-pre-wrap wrap-anywhere",
          props.muted && "text-muted-foreground",
          long && !all && "line-clamp-4",
        )}
      >
        {props.text}
      </p>
      {long && <ShowAll all={all} onToggle={() => setAll((shown) => !shown)} />}
    </>
  );
}

function ShowAll(props: { all: boolean; onToggle(): void }) {
  return (
    <div className="-mx-2 flex">
      <Button size="xs" variant="ghost" aria-expanded={props.all} onClick={props.onToggle}>
        {props.all ? "Show less" : "Show all"}
      </Button>
    </div>
  );
}

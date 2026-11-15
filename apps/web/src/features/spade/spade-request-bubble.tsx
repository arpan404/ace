import {
  spadeRequestCard,
  type SpadeBubble,
  type SpadeRequestDetail,
} from "@ace/ui-core/spade-chat";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { useSpadeConnectors } from "./spade-connector-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { readNotes } from "./spade-notes-api.ts";
import { notesKey } from "./spade-notes.tsx";

type Ask = Extract<SpadeBubble, { kind: "ask" }>;

const code =
  "no-scrollbar mt-1.5 overflow-auto rounded-md bg-code px-2.5 py-2 font-mono text-xs leading-normal whitespace-pre-wrap shadow-[inset_0_0_0_1px_var(--border)]";
/** Past this much the detail folds to a few lines, with Show all to open it in place. */
const longChars = 280;
const longLines = 6;

const isLong = (text: string) => text.length > longChars || text.split("\n").length > longLines;

/** The answers Spade takes: allow once, allow always, or deny. */
export type RequestAnswer = "allow" | "always" | "deny";

/**
 * A call the bot wants to make, as its bubble where it asked (ADR 0127): one sentence in Spade's
 * words, the detail that matters for that kind of call (folded when long), the reviewer's reason
 * as one quiet line, then Allow, Deny and, where the gate keeps it, Always allow. Answered, the
 * answer stays in place of the buttons. With focus on an open one, Enter allows and Escape denies.
 */
export function SpadeRequestBubble(props: {
  item: Ask;
  botId: string;
  botName: string;
  /** Another bot's name by its id, for a message it would send. */
  nameOf(id: string): string | undefined;
  className: string;
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
  const open = item.state === "open";
  const answer = (choice: RequestAnswer) => {
    if (answering !== undefined || !open) return;
    setAnswering(choice);
    void props.onAnswer(item.callId, choice).then((sent) => {
      if (!sent) setAnswering(undefined);
    });
  };
  return (
    <div
      role="group"
      aria-label={card.sentence.replace(/\.$/, "")}
      // Focusable while open, so Enter and Escape answer it from the keyboard.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={open ? 0 : undefined}
      onKeyDown={(event) => {
        if (!open) return;
        // Escape anywhere in it denies; Enter on the bubble itself allows (a button's own Enter
        // presses that button).
        if (event.key === "Escape") {
          event.preventDefault();
          answer("deny");
        } else if (event.key === "Enter" && event.target === event.currentTarget) {
          event.preventDefault();
          answer("allow");
        }
      }}
      className={cn(props.className, "focus-ring")}
    >
      <p>{card.sentence}</p>
      {item.reason && <p className="mt-0.5 text-ui text-muted-foreground">{item.reason}</p>}
      {card.detail && <Detail detail={card.detail} />}
      <div className="-mx-2 mt-1 -mb-1 flex flex-wrap items-center gap-1">
        {open ? (
          <>
            <Button
              size="xs"
              variant="ghost"
              disabled={answering !== undefined}
              onClick={() => answer("allow")}
            >
              {answering === "allow" ? "Allowing…" : "Allow"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={answering !== undefined}
              onClick={() => answer("deny")}
            >
              {answering === "deny" ? "Denying…" : "Deny"}
            </Button>
            {card.always && (
              <Button
                size="xs"
                variant="ghost"
                disabled={answering !== undefined}
                onClick={() => answer("always")}
              >
                {answering === "always" ? "Allowing…" : "Always allow"}
              </Button>
            )}
          </>
        ) : (
          <span className="px-2 text-ui text-muted-foreground">{answered(item)}</span>
        )}
      </div>
    </div>
  );
}

function answered(item: Ask): string {
  switch (item.state) {
    case "allowed":
      return item.always ? "Always allowed" : "Allowed";
    case "denied":
      return "Denied";
    default:
      return "Not answered";
  }
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
        <div className="mt-1">
          <p className="font-mono text-ui wrap-anywhere text-muted-foreground">{detail.path}</p>
          {detail.text !== undefined && <Folded label="Content" text={detail.text} />}
          {detail.before !== undefined && <Folded label="Replaces" text={detail.before} />}
          {detail.after !== undefined && <Folded label="With" text={detail.after} />}
        </div>
      );
    case "note":
      return (
        <div className="mt-1 flex flex-col gap-0.5 text-ui">
          {detail.before !== undefined && (
            <p className="text-muted-foreground line-through decoration-border">{detail.before}</p>
          )}
          <FoldedText text={detail.text} />
        </div>
      );
    case "email":
      return (
        <div className="mt-1 flex flex-col gap-0.5 text-ui">
          {detail.to && <Line label="To" value={detail.to} />}
          {detail.subject && <Line label="Subject" value={detail.subject} />}
          {detail.body && <FoldedText text={detail.body} muted />}
        </div>
      );
    case "message":
      return (
        <div className="mt-1 flex flex-col gap-0.5 text-ui">
          <Line label="To" value={detail.to} />
          <FoldedText text={detail.text} muted />
        </div>
      );
    case "fields":
      return (
        <div className="mt-1 flex flex-col gap-0.5 text-ui">
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

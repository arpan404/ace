import type { BotFaceState } from "@ace/ui-core/bot-face";
import {
  type SpadeTaskLine,
  parseSpadeAvatar,
  spadeBubbles,
  spadeFailureSentence,
  type SpadeBubbleFailure,
  withProposals,
  type SpadeAvatar,
  type SpadeChatItem,
  type SpadeProposal,
  type SpadeRememberedNote,
  type SpadeView,
} from "@ace/ui-core/spade-chat";
import { formatElapsed } from "@ace/ui-core/time";
import { Link } from "@tanstack/react-router";
import { memo, useEffect, useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { cn } from "@/lib/cn.ts";
import { useSeconds } from "@/lib/time.ts";
import { SpadeBubbleText } from "./spade-bubble-text.tsx";
import { SpadeFace } from "./spade-face.tsx";
import { useFaceState } from "./use-face-state.ts";
import { SkillProposal } from "./spade-skill-bubble.tsx";
import { DocumentChips, Pictures, VoicePlay } from "./spade-media.tsx";
import { canReadAloud, readAloud, stopReading, stopReadingOf, useReading } from "./spade-speech.ts";

/** The bot whose conversation this is, and the faces of other bots that write into it. */
export interface ChatBot {
  name: string;
  avatar: SpadeAvatar;
  /** Other bots by id, for the faces of messages they send here. */
  others: ReadonlyMap<string, SpadeAvatar>;
}

const bubble =
  "min-w-0 max-w-[80%] rounded-lg px-3 py-2 font-prose text-prose leading-[1.5] wrap-anywhere";
const botBubble = cn(bubble, "bg-bubble shadow-[inset_0_0_0_1px_var(--border)]");
const faceRoom = "w-7 shrink-0";

/**
 * A bot's conversation as a chat (ADR 0127): the person's bubbles on the right on the active
 * fill, the bot's on the left with its face beside the last bubble of each run, messages other
 * bots sent here under their name and face. Nothing of how the bot works shows: no tool calls,
 * jobs or compaction. An approval waits in the strip above the composer (`SpadeRequestStrip`), a
 * question arrives as the bot's bubble, a note it saved as one quiet "Remembered" line that opens the note for
 * editing (ADR 0128), a search with nothing set up as one quiet line that opens Settings › Spade ›
 * Web search, and a skill the bot offers as a bubble with Save and Discard (ADR 0130),
 * after the reply that made it. While the bot works, one line under its last bubble: its face
 * working, its few words and how long it has been at it, with Watch when its computer's tile is
 * hidden. A bot carrying on with its task by itself keeps that line between replies ("Flights is
 * working on it · its step"), and a task waiting on the person reads "Flights needs you" (the
 * request is in the strip). Stop is the composer's; a done task shows nothing more.
 */
export function SpadeChat(props: {
  bot: ChatBot;
  view: SpadeView;
  /** The computer's tile is hidden: the working line offers to watch it again. */
  onWatch?: (() => void) | undefined;
  /** The person has the bot's computer: Spade pauses the bot, and the line says so. */
  paused?: boolean | undefined;
  /** Its task's line (`spadeTaskLine`): carrying on by itself, or waiting on the person. */
  task?: SpadeTaskLine | undefined;
  onRemembered(note: SpadeRememberedNote): void;
  /** A file chip: open that file of the bot's workspace. */
  onOpenFile(path: string): void;
  proposals?: readonly SpadeProposal[];
  onProposal?(id: string, save: boolean): Promise<boolean>;
  /** An endpoint's name by its id, for a failed reply's sentence; undefined when unknown. */
  endpointName?(id: string): string | undefined;
  /** Try again on a failed reply: sends the person's last message again. */
  onRetry?(text: string): Promise<boolean>;
}) {
  const { view, bot } = props;
  // Requests wait in the strip above the composer, not among the bubbles.
  const bubbles = withProposals(spadeBubbles(view), view.entries, props.proposals ?? []).filter(
    (item) => item.kind !== "ask",
  );
  // Busy: anything open. Stop stays while it is, waiting on the person too; the face moves only
  // while the bot works itself.
  const busy = view.busy;
  const waiting = view.approvals.length > 0 || view.asking;
  // The working line's face shows what the bot does; once it stops, the face by its last
  // bubble shows it finished, then rests.
  const lineState: BotFaceState = waiting
    ? "needs-you"
    : view.status === "Thinking"
      ? "thinking"
      : "working";
  const lastFace = useFaceState(busy ? lineState : "idle", true);
  // The working line shows while the bot works itself, not while it waits on the person; a
  // task that carries on or waits on the person keeps its line between replies too.
  const working = busy && !waiting;
  const task = props.task;
  const lined = working || task !== undefined;
  return (
    <div
      role="feed"
      aria-label={`Conversation with ${bot.name}`}
      aria-busy={view.busy}
      className="flex flex-col gap-3"
    >
      {bubbles.map((item, index) => {
        const next = bubbles[index + 1];
        const last = index === bubbles.length - 1;
        // The face sits by the last of a run of one sender's bubbles, or by the working line.
        const lastOfRun = !(next && sameSender(item, next)) && !((busy || lined) && last);
        const previous = bubbles[index - 1];
        return (
          <Bubble
            key={item.key}
            item={item}
            bot={bot}
            face={lastOfRun && (last ? lastFace : "idle")}
            first={!(previous && sameSender(previous, item))}
            endpointName={props.endpointName}
            onProposal={props.onProposal}
            onRemembered={props.onRemembered}
            onOpenFile={props.onOpenFile}
            onRetry={props.onRetry}
          />
        );
      })}
      {lined &&
        (props.paused ? (
          // Paused by Spade while the person drives: nothing runs, so no clock.
          <WorkingLine
            avatar={bot.avatar}
            state="idle"
            label="Paused while you have the computer"
            since={undefined}
            onWatch={undefined}
          />
        ) : task?.tone === "needs-you" ? (
          <WorkingLine
            avatar={bot.avatar}
            state="needs-you"
            label={task.sentence}
            since={undefined}
            onWatch={undefined}
          />
        ) : (
          <WorkingLine
            avatar={bot.avatar}
            state={task && !working ? "working" : lineState}
            label={
              task
                ? [task.sentence, task.step].filter(Boolean).join(" · ")
                : (view.status ?? "Working")
            }
            since={working ? view.working?.since : undefined}
            onWatch={props.onWatch}
          />
        ))}
    </div>
  );
}

const botSide = (item: SpadeChatItem) =>
  item.kind === "bot" || item.kind === "ask" || item.kind === "skill" || item.kind === "files";

/** Two bubbles in a row from one sender: the bot's own, or the same other bot's. */
const sameSender = (a: SpadeChatItem, b: SpadeChatItem) =>
  (botSide(a) && botSide(b)) ||
  (a.kind === "other" && b.kind === "other" && a.agent.id === b.agent.id);

const Bubble = memo(function Bubble(props: {
  item: SpadeChatItem;
  bot: ChatBot;
  /** The last of its sender's run: its face shows beside it, in this state. */
  face: BotFaceState | false;
  /** The first of its sender's run: another bot's name shows above it. */
  first: boolean;
  endpointName: ((id: string) => string | undefined) | undefined;
  onProposal: ((id: string, save: boolean) => Promise<boolean>) | undefined;
  onRemembered(note: SpadeRememberedNote): void;
  onOpenFile(path: string): void;
  onRetry: ((text: string) => Promise<boolean>) | undefined;
}) {
  const { item, bot } = props;
  switch (item.kind) {
    case "person":
      return (
        <div
          role="article"
          aria-label="You"
          aria-busy={item.sending || undefined}
          className={cn("flex flex-col items-end gap-1", item.sending && "opacity-70")}
        >
          {item.images.length > 0 && <Pictures images={item.images} side="person" />}
          {item.documents.length > 0 && <DocumentChips documents={item.documents} side="person" />}
          {item.text && (
            <div className={cn(bubble, "bg-active")}>
              <SpadeBubbleText text={item.text} />
              {/* A voice message: its transcript, and the recording to play. */}
              {item.voice && (
                <div className="-mx-2 mt-0.5 -mb-1 flex">
                  <VoicePlay voice={item.voice} />
                </div>
              )}
            </div>
          )}
        </div>
      );
    case "task-paused":
      return (
        <p role="note" className="text-xs text-muted-foreground">
          {item.text}
        </p>
      );
    case "routine":
      // A routine fired (ADR 0129): a small label in the middle, never the person's bubble.
      return (
        <div role="note" className="flex justify-center">
          <span className="rounded-full bg-bubble px-2.5 py-0.5 text-xs text-muted-foreground">
            {`${item.name} · ${item.label}`}
          </span>
        </div>
      );
    case "group":
      // A group the bot is in sent it (ADR 0132): a small label, then what was asked, quietly.
      return (
        <div
          role="note"
          aria-label={`In ${item.group}`}
          className="flex flex-col items-center gap-1"
        >
          <span className="rounded-full bg-bubble px-2.5 py-0.5 text-xs text-muted-foreground">
            {item.agent ? `In ${item.group} · ${item.agent.name}` : `In ${item.group}`}
          </span>
          {item.text && (
            <p className="max-w-[80%] text-center text-xs text-muted-foreground wrap-anywhere line-clamp-3">
              {item.text}
            </p>
          )}
        </div>
      );
    case "other": {
      const avatar = bot.others.get(item.agent.id) ?? parseSpadeAvatar(undefined, item.agent.id);
      return (
        <div role="article" aria-label={item.agent.name} className="flex flex-col gap-1">
          {props.first && (
            <span className="pl-9.5 text-xs text-subtle-foreground">{item.agent.name}</span>
          )}
          <div className="flex items-end gap-2.5">
            {props.face ? (
              <SpadeFace avatar={avatar} size={28} state={props.face} />
            ) : (
              <span aria-hidden className={faceRoom} />
            )}
            <div className={botBubble}>
              <SpadeBubbleText text={item.text} />
            </div>
          </div>
        </div>
      );
    }
    case "bot": {
      const words = Boolean(item.text || item.end);
      const media = (
        <>
          {item.images.length > 0 && <Pictures images={item.images} side="bot" />}
          {item.documents.length > 0 && <DocumentChips documents={item.documents} side="bot" />}
        </>
      );
      return (
        <BotRow
          bot={bot}
          face={props.face}
          after={
            <>
              {/* What its tools showed the person, after its words (ADR 0134). */}
              {words && media}
              {item.text && !item.live && <ReadAloud text={item.text} />}
              {item.files && <FileChips paths={item.files} onOpen={props.onOpenFile} />}
            </>
          }
        >
          {/* The column beside the face, so a bubble's width is as before. */}
          <div className="flex min-w-0 flex-1 flex-col items-start">
            {words ? (
              <div className={botBubble}>
                {item.text && <SpadeBubbleText text={item.text} />}
                {item.end === "failed" && item.failure ? (
                  <Failure
                    failure={item.failure}
                    endpoint={item.failure.endpoint && props.endpointName?.(item.failure.endpoint)}
                    spaced={Boolean(item.text)}
                    onRetry={props.onRetry}
                  />
                ) : (
                  item.end && (
                    <p className={cn("text-ui text-muted-foreground", item.text && "mt-1")}>
                      {item.end === "stopped"
                        ? "Stopped"
                        : item.end === "failed"
                          ? "Couldn't finish"
                          : "Interrupted"}
                    </p>
                  )
                )}
              </div>
            ) : (
              <div className="flex min-w-0 flex-col items-start gap-1">{media}</div>
            )}
          </div>
        </BotRow>
      );
    }
    case "files":
      return (
        <BotRow bot={bot} face={props.face}>
          <div className={botBubble}>
            <FileChips paths={item.paths} onOpen={props.onOpenFile} first />
          </div>
        </BotRow>
      );
    case "handback":
      // The person handed the computer back: Spade's narration as one quiet line, and the names
      // it involved (files, addresses) as plain text behind a disclosure, never as links.
      return (
        <div role="note" className="flex flex-col items-center gap-1 text-center">
          <p className="max-w-[80%] text-xs text-muted-foreground wrap-anywhere">{item.text}</p>
          {item.data.length > 0 && (
            <Disclosure
              summary="What changed"
              summaryClassName="text-xs"
              className="flex max-w-[80%] flex-col items-center"
            >
              <ul
                aria-label="What changed"
                className="mt-1 flex flex-col gap-0.5 font-mono text-xs text-muted-foreground wrap-anywhere"
              >
                {item.data.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Disclosure>
          )}
        </div>
      );
    case "remembered":
      return (
        <div className="pl-9.5">
          <button
            type="button"
            onClick={() => props.onRemembered(item.note)}
            className="max-w-[80%] rounded-sm text-left text-xs text-muted-foreground wrap-anywhere transition-colors duration-(--motion-fast) hover:text-foreground focus-ring"
          >
            {`Remembered: ${item.note.text}`}
          </button>
        </div>
      );
    case "search-setup":
      // Web search had nothing to search with: one quiet line and the way to set it up.
      return (
        <div className="flex items-center gap-1 pl-9.5 text-xs text-muted-foreground">
          <span>Web search isn't set up.</span>
          <Link
            to="/settings/spade"
            hash="web-search"
            className={buttonVariants({ size: "xs", variant: "ghost" })}
          >
            Set up web search
          </Link>
        </div>
      );
    case "ask":
      return null;
    case "skill": {
      const answer = props.onProposal;
      return (
        <BotRow bot={bot} face={props.face}>
          <SkillProposal
            proposal={item.proposal}
            botName={bot.name}
            className={botBubble}
            onAnswer={(save) => (answer ? answer(item.proposal.id, save) : Promise.resolve(false))}
          />
        </BotRow>
      );
    }
  }
});

/**
 * A bubble of the bot's: its face (or the room for it) beside the bubble itself, bottom-aligned
 * with it, and anything under the bubble (pictures, Read aloud, file chips) below, in the
 * bubble's column, so the face never drops to their row.
 */
function BotRow(props: {
  bot: ChatBot;
  face: BotFaceState | false;
  children: React.ReactNode;
  after?: React.ReactNode;
}) {
  return (
    <div role="article" aria-label={props.bot.name} className="group/reply flex flex-col gap-1">
      <div className="flex items-end gap-2.5">
        {props.face ? (
          <SpadeFace avatar={props.bot.avatar} size={28} state={props.face} />
        ) : (
          <span aria-hidden className={faceRoom} />
        )}
        {props.children}
      </div>
      {props.after && (
        <div className="flex min-w-0 flex-col items-start gap-1 pl-9.5 empty:hidden">
          {props.after}
        </div>
      )}
    </div>
  );
}

/**
 * A failed reply: one plain sentence by its kind, naming the endpoint; Try again, which sends the
 * person's last message again; and Details, the endpoint's own words, which also stay in the
 * activity log.
 */
function Failure(props: {
  failure: SpadeBubbleFailure;
  endpoint: string | undefined;
  spaced: boolean;
  onRetry: ((text: string) => Promise<boolean>) | undefined;
}) {
  const { failure, onRetry } = props;
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const retry = failure.retry;
  return (
    <>
      <p className={cn("text-ui text-muted-foreground", props.spaced && "mt-1")}>
        {spadeFailureSentence(failure.kind, props.endpoint)}
      </p>
      {open && failure.error && (
        <pre
          aria-label="Details"
          className="no-scrollbar mt-1.5 max-h-48 overflow-auto rounded-md bg-code px-2.5 py-2 font-mono text-xs leading-normal whitespace-pre-wrap shadow-[inset_0_0_0_1px_var(--border)]"
        >
          {failure.error}
        </pre>
      )}
      <div className="-mx-2 mt-1 -mb-1 flex flex-wrap gap-1">
        {retry !== undefined && onRetry && (
          <Button
            size="xs"
            variant="ghost"
            disabled={sending}
            onClick={() => {
              setSending(true);
              void onRetry(retry).then(() => setSending(false));
            }}
          >
            {sending ? "Sending…" : "Try again"}
          </Button>
        )}
        {failure.error && (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={open}
            onClick={() => setOpen((shown) => !shown)}
          >
            Details
          </Button>
        )}
      </div>
    </>
  );
}

/**
 * While the bot works: its face moving, its few words, and how long it has been at it; Watch
 * brings its computer's tile back when the person hid it.
 */
function WorkingLine(props: {
  avatar: SpadeAvatar;
  state: BotFaceState;
  label: string;
  since: number | undefined;
  onWatch: (() => void) | undefined;
}) {
  const now = useSeconds(props.since !== undefined);
  return (
    <div role="status" className="flex items-center gap-2.5">
      <SpadeFace avatar={props.avatar} size={28} state={props.state} />
      <span className="min-w-0 truncate text-ui text-muted-foreground">{props.label}</span>
      {props.since !== undefined && (
        <span className="shrink-0 text-ui text-subtle-foreground tabular-nums">
          {formatElapsed(now - props.since)}
        </span>
      )}
      {props.onWatch && (
        <Button size="xs" variant="ghost" onClick={props.onWatch}>
          Watch
        </Button>
      )}
    </div>
  );
}

/** Most of a call's arguments a bubble shows; the rest is cut with an ellipsis. */
const maxDetailChars = 20_000;

/**
 * What an approval would do, as text: its arguments as the bot sent them, indented JSON (text
 * stays text: React escapes it). Undefined when the call carries none.
 */
export function callDetails(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
  } catch {
    return undefined;
  }
  if (!text || text === "{}") return undefined;
  return text.length > maxDetailChars ? `${text.slice(0, maxDetailChars)}…` : text;
}

/**
 * Under a bot's bubble, shown on hover or focus: Read aloud, which reads the reply in the
 * system's voice and becomes Stop reading while it speaks. Nothing where the system can't speak.
 * Leaving the chat (or moving to another bot's) stops it: the reading belongs to this bubble.
 */
function ReadAloud(props: { text: string }) {
  const key = useId();
  const reading = useReading(key);
  useEffect(() => () => stopReadingOf(key), [key]);
  if (!canReadAloud()) return null;
  return (
    <div
      className={cn(
        "-mx-2 -mt-0.5 flex transition-opacity duration-(--motion-fast)",
        !reading &&
          "opacity-0 group-hover/reply:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100",
      )}
    >
      <Button
        size="xs"
        variant="ghost"
        onClick={() => (reading ? stopReading() : readAloud(key, props.text))}
      >
        {reading ? "Stop reading" : "Read aloud"}
      </Button>
    </div>
  );
}
/**
 * Files the bot kept (a research report), each by its name: opens it in the bot's files. Under
 * the bubble's words, or alone when no words followed yet.
 */
function FileChips(props: { paths: readonly string[]; onOpen(path: string): void; first?: true }) {
  return (
    <ul aria-label="Files" className={cn("-mx-1 flex flex-wrap gap-1", !props.first && "mt-1.5")}>
      {props.paths.map((path) => (
        <li key={path}>
          <button
            type="button"
            aria-label={`Open ${path}`}
            title={path}
            onClick={() => props.onOpen(path)}
            className="max-w-full truncate rounded-sm px-1 text-ui text-muted-foreground underline decoration-border underline-offset-3 transition-colors duration-(--motion-fast) hover:text-foreground focus-ring"
          >
            {path.split("/").at(-1) ?? path}
          </button>
        </li>
      ))}
    </ul>
  );
}

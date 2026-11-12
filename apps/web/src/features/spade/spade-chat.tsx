import { initials } from "@ace/ui-core";
import {
  spadeApprovalSentence,
  spadeBubbles,
  spadeCallDetails,
  spadeShellCommand,
  spadeFailureSentence,
  type SpadeBubbleFailure,
  withProposals,
  type SpadeAvatar,
  type SpadeChatItem,
  type SpadeProposal,
  type SpadeRememberedNote,
  type SpadeView,
} from "@ace/ui-core/spade-chat";
import { Link } from "@tanstack/react-router";
import { memo, useEffect, useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { SpadeBubbleText } from "./spade-bubble-text.tsx";
import { SpadeFace } from "./spade-face.tsx";
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
 * jobs or compaction. An approval arrives as the bot's bubble with Allow and Deny, a question as
 * the bot's bubble, a note it saved as one quiet "Remembered" line that opens the note for
 * editing (ADR 0128), a search with nothing set up as one quiet line that opens Settings › Spade ›
 * Web search, and a skill the bot offers as a bubble with Save and Discard (ADR 0130),
 * after the reply that made it. While the bot
 * works, one line under its last bubble: its face with moving eyes, its few words, and Stop.
 */
export function SpadeChat(props: {
  bot: ChatBot;
  view: SpadeView;
  stopping: boolean;
  onStop(): void;
  onAnswer(callId: string, allowed: boolean, always: boolean): Promise<boolean>;
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
  const bubbles = withProposals(spadeBubbles(view), view.entries, props.proposals ?? []);
  // Busy: anything open. Stop stays while it is, waiting on the person too; the face moves only
  // while the bot works itself.
  const busy = view.busy;
  const waiting = view.approvals.length > 0 || view.asking;
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
        const lastOfRun = !(next && sameSender(item, next)) && !(busy && last);
        const previous = bubbles[index - 1];
        return (
          <Bubble
            key={item.key}
            item={item}
            bot={bot}
            face={lastOfRun}
            first={!(previous && sameSender(previous, item))}
            endpointName={props.endpointName}
            onAnswer={props.onAnswer}
            onProposal={props.onProposal}
            onRemembered={props.onRemembered}
            onOpenFile={props.onOpenFile}
            onRetry={props.onRetry}
          />
        );
      })}
      {busy && (
        <div role="status" className="flex items-center gap-2.5">
          <SpadeFace avatar={bot.avatar} size={28} working={!waiting} />
          <span className="min-w-0 truncate text-ui text-muted-foreground">
            {waiting ? "Waiting for you" : (view.status ?? "Working")}
          </span>
          <Button
            size="xs"
            variant="ghost"
            disabled={props.stopping}
            aria-label={`Stop ${bot.name}`}
            onClick={props.onStop}
          >
            {props.stopping ? "Stopping…" : "Stop"}
          </Button>
        </div>
      )}
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
  /** The last of its sender's run: its face shows beside it. */
  face: boolean;
  /** The first of its sender's run: another bot's name shows above it. */
  first: boolean;
  endpointName: ((id: string) => string | undefined) | undefined;
  onAnswer(callId: string, allowed: boolean, always: boolean): Promise<boolean>;
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
      const avatar = bot.others.get(item.agent.id) ?? {
        kind: "generated" as const,
        initials: initials(item.agent.name) || "?",
        color: "slate" as const,
      };
      return (
        <div role="article" aria-label={item.agent.name} className="flex flex-col gap-1">
          {props.first && (
            <span className="pl-9.5 text-xs text-subtle-foreground">{item.agent.name}</span>
          )}
          <div className="flex items-end gap-2.5">
            {props.face ? (
              <SpadeFace avatar={avatar} size={28} />
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
      return (
        <BotRow bot={bot} face={props.face}>
          <Ask
            sentence={spadeApprovalSentence(item.name, bot.name)}
            reason={item.reason}
            details={item.arguments}
            command={spadeShellCommand(item.name, item.arguments)}
            onAnswer={(allowed, always) => props.onAnswer(item.callId, allowed, always)}
          />
        </BotRow>
      );
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
  face: boolean;
  children: React.ReactNode;
  after?: React.ReactNode;
}) {
  return (
    <div role="article" aria-label={props.bot.name} className="group/reply flex flex-col gap-1">
      <div className="flex items-end gap-2.5">
        {props.face ? (
          <SpadeFace avatar={props.bot.avatar} size={28} />
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
 * The bot asks to use a tool: its sentence, then Allow, Deny and Details (what the call would
 * do). A command shows itself instead of Details, with "Always allow this command", which
 * allows that exact command for the bot from then on and nothing else.
 */
function Ask(props: {
  sentence: string;
  /** Why the model review asked rather than let it run. */
  reason: string | undefined;
  details: unknown;
  command: string | undefined;
  onAnswer(allowed: boolean, always: boolean): Promise<boolean>;
}) {
  const [answering, setAnswering] = useState<"allow" | "deny" | "always">();
  const [open, setOpen] = useState(false);
  const command = props.command;
  const details = command === undefined ? spadeCallDetails(props.details) : undefined;
  const answer = (choice: "allow" | "deny" | "always") => {
    setAnswering(choice);
    void props.onAnswer(choice !== "deny", choice === "always").then((sent) => {
      if (!sent) setAnswering(undefined);
    });
  };
  return (
    <div className={botBubble}>
      <p>{props.sentence}</p>
      {props.reason && (
        <p className="mt-1 text-ui text-muted-foreground">{`Asked you because: ${props.reason}`}</p>
      )}
      {command !== undefined && (
        <pre
          aria-label="Command"
          className="no-scrollbar mt-1.5 max-h-48 overflow-auto rounded-md bg-code px-2.5 py-2 font-mono text-xs leading-normal whitespace-pre-wrap shadow-[inset_0_0_0_1px_var(--border)]"
        >
          {command}
        </pre>
      )}
      {open && details && (
        <pre
          aria-label="Details"
          className="no-scrollbar mt-1.5 max-h-48 overflow-auto rounded-md bg-code px-2.5 py-2 font-mono text-xs leading-normal whitespace-pre-wrap shadow-[inset_0_0_0_1px_var(--border)]"
        >
          {details}
        </pre>
      )}
      <div className="-mx-2 mt-1 -mb-1 flex flex-wrap gap-1">
        <Button
          size="xs"
          variant="ghost"
          disabled={answering !== undefined}
          onClick={() => answer("allow")}
        >
          {answering === "allow" ? "Allowing…" : "Allow"}
        </Button>
        {command !== undefined && (
          <Button
            size="xs"
            variant="ghost"
            disabled={answering !== undefined}
            onClick={() => answer("always")}
          >
            {answering === "always" ? "Allowing…" : "Always allow this command"}
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          disabled={answering !== undefined}
          onClick={() => answer("deny")}
        >
          {answering === "deny" ? "Denying…" : "Deny"}
        </Button>
        {details && (
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
    </div>
  );
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

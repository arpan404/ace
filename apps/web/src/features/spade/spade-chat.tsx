import { initials } from "@ace/ui-core";
import {
  spadeApprovalSentence,
  spadeBubbles,
  withProposals,
  type SpadeAvatar,
  type SpadeChatItem,
  type SpadeImageRef,
  type SpadeProposal,
  type SpadeRememberedNote,
  type SpadeView,
} from "@ace/ui-core/spade-chat";
import { memo, useEffect, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { SpadeBubbleText } from "./spade-bubble-text.tsx";
import { SpadeFace } from "./spade-face.tsx";
import { SkillProposal } from "./spade-skill-bubble.tsx";
import { holdSpadePicture } from "./spade-images.ts";
import { useSpadeClient } from "./spade-machine.tsx";

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
 * editing (ADR 0128), and a skill the bot offers as a bubble with Save and Discard (ADR 0130),
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
  proposals?: readonly SpadeProposal[];
  onProposal?(id: string, save: boolean): Promise<boolean>;
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
        // The face sits by the last of a run of the bot's bubbles, or by the working line.
        const lastOfRun =
          !(next && botSide(next) && botSide(item)) && !(busy && index === bubbles.length - 1);
        return (
          <Bubble
            key={item.key}
            item={item}
            bot={bot}
            face={lastOfRun}
            onAnswer={props.onAnswer}
            onProposal={props.onProposal}
            onRemembered={props.onRemembered}
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
  item.kind === "bot" || item.kind === "ask" || item.kind === "skill";

/**
 * The exact command a shell call would run, which "always" covers (that command, nothing like
 * it); undefined for every other tool.
 */
function shellCommand(name: string, args: unknown): string | undefined {
  if (name !== "shell" || typeof args !== "object" || args === null) return undefined;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

const Bubble = memo(function Bubble(props: {
  item: SpadeChatItem;
  bot: ChatBot;
  face: boolean;
  onAnswer(callId: string, allowed: boolean, always: boolean): Promise<boolean>;
  onProposal: ((id: string, save: boolean) => Promise<boolean>) | undefined;
  onRemembered(note: SpadeRememberedNote): void;
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
          {item.images.length > 0 && <SentImages images={item.images} />}
          {item.text && (
            <div className={cn(bubble, "bg-active")}>
              <SpadeBubbleText text={item.text} />
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
    case "other": {
      const avatar = bot.others.get(item.agent.id) ?? {
        kind: "generated" as const,
        initials: initials(item.agent.name) || "?",
        color: "slate" as const,
      };
      return (
        <div role="article" aria-label={item.agent.name} className="flex flex-col gap-1">
          <span className="pl-9.5 text-xs text-subtle-foreground">{item.agent.name}</span>
          <div className="flex items-end gap-2.5">
            <SpadeFace avatar={avatar} size={28} />
            <div className={botBubble}>
              <SpadeBubbleText text={item.text} />
            </div>
          </div>
        </div>
      );
    }
    case "bot":
      return (
        <BotRow bot={bot} face={props.face}>
          <div className={botBubble}>
            {item.text && <SpadeBubbleText text={item.text} />}
            {item.end && (
              <p className={cn("text-ui text-muted-foreground", item.text && "mt-1")}>
                {item.end === "stopped"
                  ? "Stopped"
                  : item.end === "failed"
                    ? item.error
                      ? `Couldn't finish: ${item.error}`
                      : "Couldn't finish"
                    : "Interrupted"}
              </p>
            )}
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
    case "ask":
      return (
        <BotRow bot={bot} face={props.face}>
          <Ask
            sentence={spadeApprovalSentence(item.name, bot.name)}
            details={item.arguments}
            command={shellCommand(item.name, item.arguments)}
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

function BotRow(props: { bot: ChatBot; face: boolean; children: React.ReactNode }) {
  return (
    <div role="article" aria-label={props.bot.name} className="flex items-end gap-2.5">
      {props.face ? (
        <SpadeFace avatar={props.bot.avatar} size={28} />
      ) : (
        <span aria-hidden className={faceRoom} />
      )}
      {props.children}
    </div>
  );
}

/**
 * The bot asks to use a tool: its sentence, then Allow, Deny and Details (what the call would
 * do). A command shows itself instead of Details, with "Always allow this command", which
 * allows that exact command for the bot from then on and nothing else.
 */
function Ask(props: {
  sentence: string;
  details: unknown;
  command: string | undefined;
  onAnswer(allowed: boolean, always: boolean): Promise<boolean>;
}) {
  const [answering, setAnswering] = useState<"allow" | "deny" | "always">();
  const [open, setOpen] = useState(false);
  const command = props.command;
  const details = command === undefined ? callDetails(props.details) : undefined;
  const answer = (choice: "allow" | "deny" | "always") => {
    setAnswering(choice);
    void props.onAnswer(choice !== "deny", choice === "always").then((sent) => {
      if (!sent) setAnswering(undefined);
    });
  };
  return (
    <div className={botBubble}>
      <p>{props.sentence}</p>
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

/** The person's images, right-aligned above their words, each read once and kept by hash. */
function SentImages(props: { images: readonly SpadeImageRef[] }) {
  return (
    <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
      {/* The same image twice in one message is one picture shown twice: keyed by place. */}
      {props.images
        .map((image, place) => ({ hash: image.sha256, key: `${place}:${image.sha256}` }))
        .map(({ hash, key }) => (
          <SentImage key={key} hash={hash} />
        ))}
    </div>
  );
}

function SentImage(props: { hash: string }) {
  const client = useSpadeClient();
  const [shown, setShown] = useState<{ hash: string; url?: string; failed?: true }>();
  useEffect(() => {
    let live = true;
    const picture = holdSpadePicture(client, props.hash);
    picture.url.then(
      (url) => live && setShown({ hash: props.hash, url }),
      () => live && setShown({ hash: props.hash, failed: true }),
    );
    return () => {
      live = false;
      picture.release();
    };
  }, [client, props.hash]);
  const state = shown?.hash === props.hash ? shown : undefined;
  if (state?.url)
    return <img src={state.url} alt="" className="max-h-40 max-w-60 rounded-lg object-cover" />;
  return (
    <span
      role={state?.failed ? "img" : undefined}
      aria-label={state?.failed ? "An image that couldn't be loaded" : undefined}
      aria-busy={state ? undefined : true}
      className="grid h-24 w-32 place-items-center rounded-lg bg-bubble text-xs text-muted-foreground"
    >
      {state?.failed ? "Image" : null}
    </span>
  );
}

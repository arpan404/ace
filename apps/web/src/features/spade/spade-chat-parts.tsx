import {
  spadeFailureSentence,
  spadeQuickReactions,
  type SpadeMessageReactions,
  type SpadeAvatar,
  type SpadeBubbleFailure,
  type SpadeQuote,
} from "@ace/ui-core/spade-chat";
import type { BotFaceState } from "@ace/ui-core/bot-face";
import { ArrowBendUpLeftIcon, DotsThreeIcon, SmileyIcon } from "@ace/icons";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Emoji } from "@/components/emoji.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { cn } from "@/lib/cn.ts";
import { bubbleWidth } from "./spade-bubble-style.ts";
import { SpadeFace } from "./spade-face.tsx";
import {
  canSpeakWith,
  readAloud,
  stopReading,
  stopReadingOf,
  useReading,
  type SpeechVoice,
} from "./spade-speech.ts";
import { useBotVoiceContext } from "./use-spoken-replies.ts";
import {
  messageAttribute,
  messageIdsAttribute,
  useSpadeReplies,
} from "./spade-chat-replies.tsx";

/** Where no bot sets one (a club, a digest): the system's own default voice. */
const systemVoice: SpeechVoice = { engine: "system", voice: undefined };

/* What a chat's bubbles carry besides their words: a failure's line, their actions (time, Copy,
 * Read aloud), file chips, a speaker's header, the NEW divider, and the working line. */

/**
 * A failed reply: what failed and what to do, by its kind, naming the endpoint; Set up a model
 * when it failed for want of one; Try again, which answers the same turn again in its place (the
 * new reply replaces this one, nothing is posted twice); and Details, the endpoint's own words,
 * which also stay in the activity log.
 */
export function Failure(props: {
  failure: SpadeBubbleFailure;
  endpoint: string | undefined;
  spaced: boolean;
  onRetry: ((reply: string) => Promise<boolean>) | undefined;
  onSetUpModel: (() => void) | undefined;
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
          className="no-scrollbar mt-1.5 max-h-48 overflow-auto rounded-lg bg-chat-well px-3 py-2 font-mono text-xs leading-normal whitespace-pre-wrap"
        >
          {failure.error}
        </pre>
      )}
      <div className="-mx-2 mt-1 -mb-1 flex flex-wrap gap-1">
        {failure.kind === "no_model" && props.onSetUpModel && (
          <Button size="xs" variant="ghost" onClick={props.onSetUpModel}>
            Set up a model
          </Button>
        )}
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
            {sending ? "Trying again…" : "Try again"}
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
 * While the bot works, where its next bubble will appear: its small face moving, one line of what
 * it is doing and what that touches (the command it runs, in mono); Watch opens the right panel
 * on what it uses.
 */
export function WorkingLine(props: {
  avatar: SpadeAvatar;
  state: BotFaceState;
  label: string;
  /** What the step running now touches: its command, a path, an address. */
  detail?: string | undefined;
  since: number | undefined;
  onWatch: (() => void) | undefined;
}) {
  const moving = props.state === "working" || props.state === "thinking";
  return (
    <div
      role="status"
      className="group/work mt-(--chat-turn-gap) flex min-w-0 items-center gap-2 first:mt-0"
    >
      <SpadeFace avatar={props.avatar} size={24} state={props.state} />
      {props.onWatch ? (
        <button
          type="button"
          aria-label="Open its work"
          onClick={props.onWatch}
          className="min-w-0 cursor-pointer rounded-sm text-left focus-ring"
        >
          <span
            // Its current phrase, a soft light sweeping across it while it works. Plain text.
            key={moving ? props.label : undefined}
            className={cn(
              "min-w-0 truncate text-ui text-muted-foreground",
              moving && "step-shimmer step-shimmer-live",
              props.detail && "max-w-1/2 shrink-0",
            )}
          >
            {props.label}
          </span>
        </button>
      ) : (
        <span
          // Its current phrase, a soft light sweeping across it while it works. Plain text.
          key={moving ? props.label : undefined}
          className={cn(
            "min-w-0 truncate text-ui text-muted-foreground",
            moving && "step-shimmer step-shimmer-live",
            props.detail && "max-w-1/2 shrink-0",
          )}
        >
          {props.label}
        </span>
      )}
      {props.detail && (
        <code className="min-w-0 truncate font-mono text-xs text-subtle-foreground">
          {props.detail}
        </code>
      )}
      {props.onWatch && (
        <Button
          size="xs"
          variant="ghost"
          onClick={(event) => {
            event.stopPropagation();
            props.onWatch?.();
          }}
          className="opacity-0 transition-opacity group-hover/work:opacity-100 focus-visible:opacity-100"
        >
          Watch
        </Button>
      )}
    </div>
  );
}

/**
 * A club member's or another bot's sender header: small face and name once per run of messages,
 * aligned flush to the bubble's edge, with optional quiet inline relay context ("answering Spade").
 */
export function SpeakerLine(props: {
  avatar: SpadeAvatar;
  name: string;
  detail?: string | undefined;
  align?: "start" | "end";
}) {
  return (
    <div
      className={cn(
        "mb-1 flex max-w-full min-w-0 items-center gap-1.5 text-xs leading-4",
        props.align === "end" ? "justify-end" : "justify-start",
      )}
    >
      <SpadeFace avatar={props.avatar} size={20} />
      <span className="truncate font-medium text-foreground/85">{props.name}</span>
      {props.detail && (
        <span className="truncate text-subtle-foreground">{`· ${props.detail}`}</span>
      )}
    </div>
  );
}

/** Unread divider between previously seen and newly arrived messages. */
export function NewDivider(props: { className?: string }) {
  return (
    <div
      role="separator"
      aria-label="New messages"
      className={cn("my-5 flex items-center gap-3", props.className)}
    >
      <span aria-hidden className="h-px flex-1 bg-link/30" />
      <span className="text-[11px] font-semibold tracking-wider text-link uppercase">NEW</span>
      <span aria-hidden className="h-px flex-1 bg-link/30" />
    </div>
  );
}

/** How long a press on touch is held before the bubble's actions come up. */
const holdFor = 450;

/** A quiet bare icon beside a bubble: no fill until hovered, subtle muted ink. */
const bare =
  "size-7 rounded-full bg-transparent text-subtle-foreground hover:bg-hover/60 hover:text-foreground aria-expanded:bg-hover/60 aria-expanded:text-foreground [&_svg]:size-[18px]";

/** Overlapping the bubble's bottom edge: what each side reacted with. The person's comes off on click. */
function ReactionChips(props: {
  mark: SpadeMessageReactions;
  side: "bot" | "mine";
  onRemove: (() => void) | undefined;
}) {
  const { person, bot } = props.mark;
  const chip =
    "-mt-2 inline-flex h-6 items-center rounded-full bg-chat-raised px-1.5 text-sm leading-none shadow-[0_0_0_2px_var(--background)]";
  return (
    <span
      className={cn(
        "relative z-10 flex gap-1 px-2.5",
        props.side === "bot" ? "self-start" : "self-end",
      )}
    >
      {person &&
        (props.onRemove ? (
          <button
            type="button"
            aria-label={`Remove your ${person} reaction`}
            onClick={props.onRemove}
            className={cn(chip, "cursor-pointer focus-ring hover:bg-hover")}
          >
            <Emoji emoji={person} className="size-3.5" />
          </button>
        ) : (
          <span aria-label={`You reacted ${person}`} className={chip}>
            <Emoji emoji={person} className="size-3.5" />
          </span>
        ))}
      {bot && (
        <span aria-label={`Reacted ${bot}`} className={chip}>
          <Emoji emoji={bot} className="size-3.5" />
        </span>
      )}
    </span>
  );
}

/** Combine reactions across any merged message ids in a coalesced block. */
function reactionsFor(
  ids: readonly string[],
  map: ReadonlyMap<string, SpadeMessageReactions> | undefined,
): { mark: SpadeMessageReactions | undefined; personId: string | undefined } {
  if (!map || ids.length === 0) return { mark: undefined, personId: undefined };
  let person: string | undefined;
  let personId: string | undefined;
  let bot: string | undefined;
  for (const id of ids) {
    const entry = map.get(id);
    if (!entry) continue;
    if (entry.person && !person) {
      person = entry.person;
      personId = id;
    }
    if (entry.bot && !bot) bot = entry.bot;
  }
  if (!person && !bot) return { mark: undefined, personId: undefined };
  return { mark: { ...(person ? { person } : {}), ...(bot ? { bot } : {}) }, personId };
}

/**
 * A bubble with its outside hover actions (react, reply, more) and bottom-overlapping reaction
 * chips. Reply quotes live inside the bubble itself (`QuoteInset`). Actions stay vertically
 * centered on the bubble even when reaction chips hang below it.
 */
export function BubbleFrame(props: {
  /** The words Copy takes, without their marks; undefined for none. */
  copy: string | undefined;
  /** The words Read aloud says; undefined where it has nothing to say. */
  speak: string | undefined;
  /** "Today 9:00 AM"; undefined when unknown. */
  when: string | undefined;
  /** The More menu's Keep as a test, on a finished reply's last words (ADR 0204). */
  onKeep?: (() => void) | undefined;
  /** The More menu's Show work (or Hide work, once shown): that turn's steps, under it. */
  work?: { shown: boolean; toggle(): void } | undefined;
  /** The message as Reply quotes it, once stored (ADR 0212 §4); undefined offers no Reply. */
  reply?: SpadeQuote | undefined;
  /** All message ids merged into this bubble, for jump-to-original and reactions. */
  messageIds?: readonly string[] | undefined;
  side: "bot" | "mine";
  children: ReactNode;
}) {
  const key = useId();
  const reading = useReading(key);
  const [held, setHeld] = useState(false);
  const [copied, setCopied] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => stopReadingOf(key), [key]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!held) return;
    const away = (event: PointerEvent) => {
      if (!frame.current?.contains(event.target as Node)) setHeld(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [held]);
  const voice = useBotVoiceContext() ?? systemVoice;
  const replies = useSpadeReplies();
  const reply = replies && props.reply;
  const speak = props.speak !== undefined && canSpeakWith(voice) ? props.speak : undefined;
  const copy = props.copy;
  const onKeep = props.onKeep;
  const work = props.work;
  const [menu, setMenu] = useState(false);
  const [picking, setPicking] = useState(false);
  const ids =
    props.messageIds && props.messageIds.length > 0
      ? props.messageIds
      : props.reply
        ? [props.reply.id]
        : [];
  const primaryId = ids[0];
  const { mark, personId } = reactionsFor(ids, replies?.reactions);
  const react = replies?.react;
  // The person reacts to the bot's words; the bot's reactions to theirs just show.
  const canReact = props.side === "bot" && react !== undefined && primaryId !== undefined;
  const lit = replies?.lit !== undefined && ids.includes(replies.lit);
  const release = () => clearTimeout(timer.current);
  return (
    <div
      ref={frame}
      {...(primaryId ? { [messageAttribute]: primaryId } : {})}
      {...(ids.length > 1 ? { [messageIdsAttribute]: ids.join(" ") } : {})}
      data-lit={lit || undefined}
      className={cn(
        // The frame takes the side's width limit; the bubble inside fills it (`framed`).
        "group/bubble flex min-w-0 scroll-my-24 flex-col",
        props.side === "bot" ? "items-start" : "items-end",
        bubbleWidth[props.side],
        // Gone to from a quote: lit a moment, then back (`--motion-slow` out).
        "rounded-(--chat-bubble-radius) outline-2 outline-offset-2 outline-transparent transition-[outline-color] duration-(--motion-slow) data-lit:outline-ring",
        held && "select-none",
      )}
      onPointerDown={(event) => {
        if (event.pointerType !== "touch") return;
        release();
        timer.current = setTimeout(() => setHeld(true), holdFor);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerMove={release}
      onContextMenu={(event) => {
        // A long press on touch opens the actions, never the system's menu.
        if (held) event.preventDefault();
      }}
    >
      <div className="relative flex w-fit max-w-full min-w-0 items-center">
        {props.children}
        <div
          data-held={held || reading || menu || picking || undefined}
          className={cn(
            // Bare icons beside the bubble, centred on it: to its right for the bot's words,
            // its left for the person's. The padding (not a margin) keeps the hover unbroken.
            "absolute top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 text-subtle-foreground",
            props.side === "bot" ? "left-full pl-2" : "right-full pr-2",
            "pointer-events-none opacity-0 transition-opacity duration-(--motion-fast) group-hover/bubble:pointer-events-auto group-hover/bubble:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 data-held:pointer-events-auto data-held:opacity-100",
          )}
        >
          {canReact && (
            <Menu open={picking} onOpenChange={setPicking}>
              <MenuTrigger
                render={<IconButton icon={SmileyIcon} label="React" size="sm" className={bare} />}
              />
              <MenuContent align="center" className="flex min-w-0 flex-row gap-0.5 p-1">
                {spadeQuickReactions.map((emoji) => (
                  <MenuItem
                    key={emoji}
                    aria-label={`React ${emoji}`}
                    className="size-8 justify-center p-0 text-lg"
                    onClick={() =>
                      react(personId ?? primaryId, mark?.person === emoji ? undefined : emoji)
                    }
                  >
                    <Emoji emoji={emoji} className="size-5" />
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          )}
          {reply && (
            <IconButton
              icon={ArrowBendUpLeftIcon}
              label="Reply"
              size="sm"
              className={bare}
              onClick={() => {
                setHeld(false);
                replies.reply(reply);
              }}
            />
          )}
          <Menu open={menu} onOpenChange={setMenu}>
            <MenuTrigger
              render={<IconButton icon={DotsThreeIcon} label="More" size="sm" className={bare} />}
            />
            <MenuContent align="end">
              {props.when && (
                <div className="px-2.5 py-1.5 text-xs leading-4 text-subtle-foreground tabular-nums">
                  {`Sent ${props.when}`}
                </div>
              )}
              {copy !== undefined && (
                <MenuItem
                  onClick={() =>
                    void navigator.clipboard?.writeText(copy).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    })
                  }
                >
                  {copied ? "Copied" : "Copy"}
                </MenuItem>
              )}
              {speak !== undefined && (
                <MenuItem onClick={() => (reading ? stopReading() : readAloud(key, speak, voice))}>
                  {reading ? "Stop reading" : "Read aloud"}
                </MenuItem>
              )}
              {work && (
                <MenuItem onClick={work.toggle}>{work.shown ? "Hide work" : "Show work"}</MenuItem>
              )}
              {onKeep && <MenuItem onClick={onKeep}>Keep as a test</MenuItem>}
            </MenuContent>
          </Menu>
        </div>
      </div>
      {mark && (
        <ReactionChips
          mark={mark}
          side={props.side}
          onRemove={canReact ? () => react(personId ?? primaryId, undefined) : undefined}
        />
      )}
    </div>
  );
}

/**
 * Files the bot kept (a research report), each by its name: opens it in the bot's files. Under
 * the bubble's words, or alone when no words followed yet.
 */
export function FileChips(props: {
  paths: readonly string[];
  onOpen(path: string): void;
  first?: true;
}) {
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

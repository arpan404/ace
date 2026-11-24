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
import { messageAttribute, QuoteLine, useSpadeReplies } from "./spade-chat-replies.tsx";

/** Where no bot sets one (a club, a digest): the system's own default voice. */
const systemVoice: SpeechVoice = { engine: "system", voice: undefined };

/* What a chat's bubbles carry besides their words: a failure's line, their actions (time, Copy,
 * Read aloud), file chips, a reply's steps and a speaker's name; and the working line. */

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
 * While the bot works, where its next bubble will appear: its 32px face moving, one line of what
 * it is doing and what that touches (the command it runs, in mono), and how long it has been at
 * it; Watch opens the right panel on what it uses.
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
      className="group/work mt-(--chat-turn-gap) flex min-w-0 items-center gap-2.5 px-1 first:mt-0"
    >
      <SpadeFace avatar={props.avatar} size={28} state={props.state} />
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

/** A group member's or another bot's turn: its 24px face and name, above its run. */
export function SpeakerLine(props: { avatar: SpadeAvatar; name: string }) {
  return (
    <div className="mb-1.5 ml-1 flex min-w-0 items-center gap-2 text-ui font-medium text-muted-foreground">
      <SpadeFace avatar={props.avatar} size={24} />
      <span className="truncate">{props.name}</span>
    </div>
  );
}

/** How long a press on touch is held before the bubble's actions come up. */
const holdFor = 450;

/** A bare action beside a bubble: no fill, muted until hovered. */
const bare =
  "size-7 rounded-full bg-transparent text-subtle-foreground hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent [&_svg]:size-5";

/** Under a bubble's corner: what each side reacted with. The person's own comes off on a click. */
function ReactionChips(props: {
  mark: SpadeMessageReactions;
  side: "bot" | "mine";
  onRemove: (() => void) | undefined;
}) {
  const { person, bot } = props.mark;
  const chip =
    "-mt-2 rounded-full bg-chat-raised px-1.5 text-sm leading-6 shadow-[0_0_0_2px_var(--background)]";
  return (
    <span
      className={cn(
        "relative z-10 flex gap-1 px-3",
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
            <Emoji emoji={person} className="size-4" />
          </button>
        ) : (
          <span aria-label={`You reacted ${person}`} className={chip}>
            <Emoji emoji={person} className="size-4" />
          </span>
        ))}
      {bot && (
        <span aria-label={`Reacted ${bot}`} className={chip}>
          <Emoji emoji={bot} className="size-4" />
        </span>
      )}
    </span>
  );
}

/**
 * A bubble with its actions: the exact time, Copy and (for the bot's words, where the system can
 * speak) Read aloud, in a small pill at its foot, in room the frame keeps for it, so it never
 * covers what is under the bubble. They come up on hover and on focus, and on a
 * long press on touch, which a tap elsewhere puts away. Read aloud becomes Stop reading while it
 * speaks, in the bot's own voice, and leaving the chat stops it: the reading belongs to this
 * bubble.
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
  /** The message it replies to: a quoted line above it. */
  quote?: SpadeQuote | undefined;
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
  const messageId = props.reply?.id;
  const mark = messageId === undefined ? undefined : replies?.reactions.get(messageId);
  const react = replies?.react;
  // The person reacts to the bot's words; the bot's reactions to theirs just show.
  const canReact = props.side === "bot" && react !== undefined && messageId !== undefined;
  const any = true;
  const lit = props.reply !== undefined && replies?.lit === props.reply.id;
  const release = () => clearTimeout(timer.current);
  return (
    <div
      ref={frame}
      {...(props.reply ? { [messageAttribute]: props.reply.id } : {})}
      data-lit={lit || undefined}
      className={cn(
        // The frame takes the side's width limit; the bubble inside fills it (`framed`).
        "group/bubble relative flex min-w-0 scroll-my-24 flex-col gap-1",
        props.side === "bot" ? "items-start" : "items-end",
        bubbleWidth[props.side],
        // Gone to from a quote: lit a moment, then back (`--motion-slow` out).
        "rounded-(--chat-bubble-radius) outline-2 outline-offset-2 outline-transparent transition-[outline-color] duration-(--motion-slow) data-lit:outline-ring",
        held && "select-none",
      )}
      onPointerDown={(event) => {
        if (event.pointerType !== "touch" || !any) return;
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
      {props.quote && <QuoteLine quote={props.quote} side={props.side} />}
      {props.children}
      {any && (
        <div
          data-held={held || reading || menu || picking || undefined}
          className={cn(
            // Bare icons beside the bubble, centred on it: to its right for the bot's words,
            // its left for the person's. The padding (not a margin) keeps the hover unbroken.
            "absolute top-1/2 z-10 flex -translate-y-1/2 items-center gap-2.5 text-subtle-foreground",
            props.side === "bot" ? "left-full pl-3" : "right-full pr-3",
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
                    onClick={() => react(messageId, mark?.person === emoji ? undefined : emoji)}
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
      )}
      {mark && (
        <ReactionChips
          mark={mark}
          side={props.side}
          onRemove={canReact ? () => react(messageId, undefined) : undefined}
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

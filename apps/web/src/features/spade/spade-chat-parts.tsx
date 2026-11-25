import {
  spadeAggregateReactions,
  spadeFailureSentence,
  spadeQuickReactions,
  type SpadeAvatar,
  type SpadeBubbleFailure,
  type SpadeQuote,
  type SpadeReactionGroup,
} from "@ace/ui-core/spade-chat";
import type { BotFaceState } from "@ace/ui-core/bot-face";
import { ArrowBendUpLeftIcon, DotsThreeIcon, SmileyIcon } from "@ace/icons";
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
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
  ReplyGhost,
  type SpadeReactor,
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

/** One aggregated emoji chip with optional count, own-reaction highlight, toggle on click, and hover/long-press who-reacted card. */
function ReactionChip(props: {
  group: SpadeReactionGroup;
  side: "bot" | "mine";
  canReact: boolean;
  onToggle: ((emoji: string, mine: boolean) => void) | undefined;
  reactorOf: ((id: string) => SpadeReactor | undefined) | undefined;
}) {
  const { group, side, canReact, onToggle, reactorOf } = props;
  const mine = group.by.includes("person");
  const count = group.by.length;
  const [shown, setShown] = useState(false);
  const longPressed = useRef(false);
  const chipRef = useRef<HTMLSpanElement>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(holdTimer.current), []);
  useEffect(() => {
    if (!shown) return;
    const away = (event: PointerEvent) => {
      if (!chipRef.current?.contains(event.target as Node)) setShown(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [shown]);

  const reactors = group.by.map((id) => {
    const found = reactorOf?.(id);
    if (found) return { id, ...found };
    if (id === "person") return { id, name: "You" };
    return { id, name: id === "bot" ? "Spade" : id };
  });
  const names = reactors.map((reactor) => reactor.name);
  const chipClass = cn(
    "inline-flex h-6 items-center gap-1 rounded-full text-[12px] leading-none shadow-[0_0_0_2px_var(--background)] transition-colors duration-(--motion-fast)",
    count > 1 ? "px-2" : "px-1.5",
    mine
      ? "bg-[color-mix(in_oklab,var(--chat-mine)_22%,var(--chat-raised))] text-foreground ring-1 ring-inset ring-[color-mix(in_oklab,var(--chat-mine)_55%,transparent)]"
      : "bg-chat-raised text-muted-foreground ring-1 ring-inset ring-foreground/[0.08]",
    canReact &&
      (mine
        ? "cursor-pointer focus-ring hover:bg-[color-mix(in_oklab,var(--chat-mine)_30%,var(--chat-raised))]"
        : "cursor-pointer focus-ring hover:bg-hover hover:text-foreground"),
  );
  const label = mine
    ? count > 1
      ? `Remove your ${group.emoji} reaction (${count} reactions: ${names.join(", ")})`
      : `Remove your ${group.emoji} reaction`
    : canReact
      ? count > 1
        ? `React ${group.emoji} (${count} reactions: ${names.join(", ")})`
        : `React ${group.emoji} (${names.join(", ")})`
      : count > 1
        ? `Reacted ${group.emoji} (${count}: ${names.join(", ")})`
        : `Reacted ${group.emoji}`;
  const content = (
    <>
      <Emoji emoji={group.emoji} className="size-3.5 shrink-0" />
      {count > 1 && <span className="text-[11px] font-medium tabular-nums">{count}</span>}
    </>
  );
  const clearHold = () => clearTimeout(holdTimer.current);
  const touchProps = {
    onPointerDown: (event: ReactPointerEvent) => {
      if (event.pointerType !== "touch") return;
      event.stopPropagation();
      longPressed.current = false;
      clearHold();
      holdTimer.current = setTimeout(() => {
        longPressed.current = true;
        setShown(true);
      }, holdFor);
    },
    onPointerUp: clearHold,
    onPointerCancel: clearHold,
    onPointerMove: clearHold,
    onContextMenu: (event: ReactMouseEvent) => {
      if (longPressed.current) event.preventDefault();
    },
  };

  return (
    <span
      ref={chipRef}
      className="relative inline-flex"
      onMouseEnter={() => setShown(true)}
      onMouseLeave={() => setShown(false)}
    >
      {canReact && onToggle ? (
        <button
          type="button"
          aria-label={label}
          aria-pressed={mine}
          data-mine={mine || undefined}
          onFocus={() => setShown(true)}
          onBlur={() => setShown(false)}
          onClick={() => {
            if (longPressed.current) {
              longPressed.current = false;
              return;
            }
            onToggle(group.emoji, mine);
          }}
          {...touchProps}
          className={chipClass}
        >
          {content}
        </button>
      ) : (
        <span
          tabIndex={0}
          aria-label={label}
          data-mine={mine || undefined}
          onFocus={() => setShown(true)}
          onBlur={() => setShown(false)}
          {...touchProps}
          className={cn(chipClass, "focus-ring")}
        >
          {content}
        </span>
      )}
      {shown && (
        <div
          role="tooltip"
          className={cn(
            "pointer-events-none absolute bottom-full z-30 mb-1.5 flex min-w-28 flex-col gap-1 rounded-xl border border-border bg-popover px-2.5 py-2 text-[12px] leading-4 text-popover-foreground shadow-lg whitespace-nowrap",
            side === "bot" ? "left-0" : "right-0",
          )}
        >
          {reactors.map((reactor) => (
            <div key={reactor.id} className="flex items-center gap-1.5">
              {reactor.avatar ? (
                <SpadeFace avatar={reactor.avatar} size={18} />
              ) : (
                <span
                  aria-hidden
                  className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-chat-mine/25 text-[10px] font-semibold text-foreground"
                >
                  {reactor.name.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className={cn("truncate", reactor.id === "person" && "font-medium")}>
                {reactor.name}
              </span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

/** Under the bubble's corner: one wrapping chip per emoji with count and who-reacted popover. */
function ReactionChips(props: {
  groups: readonly SpadeReactionGroup[];
  side: "bot" | "mine";
  canReact: boolean;
  onToggle: ((emoji: string, mine: boolean) => void) | undefined;
  reactorOf: ((id: string) => SpadeReactor | undefined) | undefined;
}) {
  return (
    <div
      role="group"
      aria-label="Reactions"
      className={cn(
        "relative z-20 -mt-2 flex max-w-full flex-wrap gap-1 px-2.5",
        props.side === "bot" ? "self-start justify-start" : "self-end justify-end",
      )}
    >
      {props.groups.map((group) => (
        <ReactionChip
          key={group.emoji}
          group={group}
          side={props.side}
          canReact={props.canReact}
          onToggle={props.onToggle}
          reactorOf={props.reactorOf}
        />
      ))}
    </div>
  );
}

/**
 * A bubble with its optional messenger-style ghost reply above it, outside hover actions (react,
 * reply, more), and bottom-overlapping aggregated reaction chips. Actions stay vertically centered
 * on the reply bubble itself even when a ghost reply sits above or reaction chips hang below.
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
  /** The earlier message this bubble replies to, drawn as a faded ghost bubble above it. */
  quote?: SpadeQuote | undefined;
  /** Club member name when a club member is replying (for "Flights replied to Inbox"). */
  replier?: string | undefined;
  /** All message ids merged into this bubble, for jump-to-original and reactions. */
  messageIds?: readonly string[] | undefined;
  side: "bot" | "mine";
  className?: string | undefined;
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
  const groups = spadeAggregateReactions(ids.map((id) => replies?.reactions.get(id)));
  const personId = ids.find((id) => replies?.reactions.get(id)?.person !== undefined);
  const personEmoji = personId ? replies?.reactions.get(personId)?.person : undefined;
  const react = replies?.react;
  // In a bot's own chat the person reacts to the bot's words; in a club they can react to any message.
  const canReact =
    (props.side === "bot" || replies?.canReactOwn === true) &&
    react !== undefined &&
    primaryId !== undefined;
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
        props.className,
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
      {props.quote && <ReplyGhost quote={props.quote} side={props.side} replier={props.replier} />}
      <div
        className={cn(
          "relative z-10 flex w-fit max-w-full min-w-0 items-center",
          props.quote && "-mt-1.5 [&>*:first-child]:shadow-[0_0_0_2px_var(--background)]",
        )}
      >
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
                      react(personId ?? primaryId, personEmoji === emoji ? undefined : emoji)
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
      {groups.length > 0 && (
        <ReactionChips
          groups={groups}
          side={props.side}
          canReact={canReact}
          onToggle={
            canReact
              ? (emoji, mine) => react(personId ?? primaryId, mine ? undefined : emoji)
              : undefined
          }
          reactorOf={replies?.reactorOf}
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

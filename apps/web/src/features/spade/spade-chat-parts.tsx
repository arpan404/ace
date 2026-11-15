import {
  spadeFailureSentence,
  type SpadeAvatar,
  type SpadeBubbleFailure,
} from "@ace/ui-core/spade-chat";
import type { BotFaceState } from "@ace/ui-core/bot-face";
import { formatElapsed } from "@ace/ui-core/time";
import { CheckIcon, CopyIcon, SpeakerHighIcon, SpeakerSlashIcon } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import { useSeconds } from "@/lib/time.ts";
import { bubbleWidth } from "./spade-bubble-style.ts";
import { SpadeFace } from "./spade-face.tsx";
import { canReadAloud, readAloud, stopReading, stopReadingOf, useReading } from "./spade-speech.ts";

/* What a chat's bubbles carry besides their words: a failure's line, their actions (time, Copy,
 * Read aloud), file chips, a reply's steps and a speaker's name; and the working line. */

/**
 * A failed reply: one plain sentence by its kind, naming the endpoint; Try again, which sends the
 * person's last message again; and Details, the endpoint's own words, which also stay in the
 * activity log.
 */
export function Failure(props: {
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
          className="no-scrollbar mt-1.5 max-h-48 overflow-auto rounded-lg bg-chat-well px-3 py-2 font-mono text-xs leading-normal whitespace-pre-wrap"
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
 * While the bot works, where its next bubble will appear: its 32px face moving, one line of what
 * it is doing, and how long it has been at it; Watch opens the right panel on what it uses.
 */
export function WorkingLine(props: {
  avatar: SpadeAvatar;
  state: BotFaceState;
  label: string;
  since: number | undefined;
  onWatch: (() => void) | undefined;
}) {
  const now = useSeconds(props.since !== undefined);
  return (
    <div
      role="status"
      className="mt-(--chat-turn-gap) flex min-w-0 items-center gap-2.5 first:mt-0"
    >
      <SpadeFace avatar={props.avatar} size={32} state={props.state} />
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

/**
 * A bubble with its actions: the exact time, Copy and (for the bot's words, where the system can
 * speak) Read aloud, in a small pill at its foot. They come up on hover and on focus, and on a
 * long press on touch, which a tap elsewhere puts away. Read aloud becomes Stop reading while it
 * speaks, and leaving the chat stops it: the reading belongs to this bubble.
 */
export function BubbleFrame(props: {
  /** The words Copy takes, without their marks; undefined for none. */
  copy: string | undefined;
  /** The words Read aloud says; undefined where it has nothing to say. */
  speak: string | undefined;
  /** "Today 9:00 AM"; undefined when unknown. */
  when: string | undefined;
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
  const speak = props.speak !== undefined && canReadAloud() ? props.speak : undefined;
  const copy = props.copy;
  const any = copy !== undefined || speak !== undefined || props.when !== undefined;
  const release = () => clearTimeout(timer.current);
  return (
    <div
      ref={frame}
      className={cn(
        // The frame takes the side's width limit; the bubble inside fills it (`framed`).
        "group/bubble relative flex min-w-0 flex-col",
        props.side === "bot" ? "items-start" : "items-end",
        bubbleWidth[props.side],
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
      {props.children}
      {any && (
        <div
          data-held={held || reading || undefined}
          className={cn(
            "absolute -bottom-4.5 z-10 flex items-center gap-0.5 rounded-full bg-popover p-0.5 text-popover-foreground shadow-glass transition-opacity duration-(--motion-fast)",
            props.side === "bot" ? "right-2.5" : "left-2.5",
            "pointer-events-none opacity-0 group-hover/bubble:pointer-events-auto group-hover/bubble:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 data-held:pointer-events-auto data-held:opacity-100",
          )}
        >
          {props.when && (
            <span className="px-2 text-xs leading-4 text-subtle-foreground tabular-nums">
              {props.when}
            </span>
          )}
          {copy !== undefined && (
            <IconButton
              icon={copied ? CheckIcon : CopyIcon}
              label={copied ? "Copied" : "Copy"}
              size="sm"
              className="rounded-full"
              onClick={() =>
                void navigator.clipboard?.writeText(copy).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            />
          )}
          {speak !== undefined && (
            <IconButton
              icon={reading ? SpeakerSlashIcon : SpeakerHighIcon}
              label={reading ? "Stop reading" : "Read aloud"}
              size="sm"
              className="rounded-full"
              onClick={() => (reading ? stopReading() : readAloud(key, speak))}
            />
          )}
        </div>
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

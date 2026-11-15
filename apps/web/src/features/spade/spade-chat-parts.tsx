import {
  spadeFailureSentence,
  type SpadeAvatar,
  type SpadeBubbleFailure,
} from "@ace/ui-core/spade-chat";
import type { BotFaceState } from "@ace/ui-core/bot-face";
import { formatElapsed } from "@ace/ui-core/time";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { useSeconds } from "@/lib/time.ts";
import { SpadeFace } from "./spade-face.tsx";
import { canReadAloud, readAloud, stopReading, stopReadingOf, useReading } from "./spade-speech.ts";

/* What a bot's bubbles carry besides their words: a failure's line, Read aloud, file chips; and
 * the working line under the conversation. */

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
 * While the bot works: its face moving, its few words, and how long it has been at it; Watch
 * opens the right panel on what it uses.
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
    <div role="status" className="mt-6 flex items-center gap-2 first:mt-0">
      <SpadeFace avatar={props.avatar} size={28} state={props.state} />
      <span className="ml-1 min-w-0 truncate text-ui text-muted-foreground">{props.label}</span>
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

/**
 * On a run's time line, shown while the run is hovered or focused: Read aloud, which reads the
 * run's words in the system's voice and becomes Stop reading while it speaks. It takes no room
 * of its own. Nothing where the system can't speak. Leaving the chat (or moving to another
 * bot's) stops it: the reading belongs to this run.
 */
export function ReadAloud(props: { text: string }) {
  const key = useId();
  const reading = useReading(key);
  useEffect(() => () => stopReadingOf(key), [key]);
  if (!canReadAloud()) return null;
  return (
    <div
      className={cn(
        "-my-1 flex transition-opacity duration-(--motion-fast)",
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

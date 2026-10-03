import { cn } from "@/lib/cn.ts";
import { useCallback, useEffect, useEffectEvent, useRef, useSyncExternalStore } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import type { Row, Style } from "./screen.ts";
import type { TerminalSessions } from "./sessions.ts";

const keys: Record<string, string> = {
  Enter: "\r",
  Backspace: "\x7f",
  Tab: "\t",
  Escape: "\x1b",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  Delete: "\x1b[3~",
};

/** Bytes a key press sends to a PTY, or undefined when the key is not the terminal's. */
export function keyBytes(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">) {
  if (event.metaKey) return undefined;
  if (event.ctrlKey && !event.altKey && /^[a-z]$/i.test(event.key))
    return String.fromCharCode(event.key.toUpperCase().charCodeAt(0) - 64);
  if (event.ctrlKey) return undefined;
  const mapped = keys[event.key];
  if (mapped) return mapped;
  return event.key.length === 1 ? event.key : undefined;
}

const tones: Record<NonNullable<Style["tone"]>, string> = {
  red: "text-status-failed",
  green: "text-status-done",
  yellow: "text-status-needs-you",
  blue: "text-status-working",
  magenta: "text-status-waiting",
  cyan: "text-status-unresponsive",
};

/** The rows of a screen, monospace, following output to the bottom unless scrolled up. */
export function ScreenRows(props: { rows: readonly Row[]; label: string; className?: string }) {
  const end = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const rows = props.rows;
  useEffect(() => {
    if (stick.current && rows.length) end.current?.scrollIntoView?.({ block: "end" });
  }, [rows]);
  return (
    <div
      role="log"
      aria-label={props.label}
      aria-live="off"
      onScroll={(event) => {
        const box = event.currentTarget;
        stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
      }}
      className={cn(
        "min-h-0 flex-1 overflow-auto px-4 pt-2 pb-4 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap text-muted-foreground",
        props.className,
      )}
    >
      {props.rows.map((row) => (
        <div key={row.id} className="min-h-[1.6em] break-all">
          {row.segments.map((segment, index) => (
            <span
              // Segments have no identity of their own; their order within a row is it.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              className={cn(
                segment.style.bold && "font-medium text-foreground",
                segment.style.dim && "text-subtle-foreground",
                segment.style.tone && tones[segment.style.tone],
              )}
            >
              {segment.text}
            </span>
          ))}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

function useSession(sessions: TerminalSessions, id: string) {
  const subscribe = useCallback(
    (changed: () => void) => sessions.watch(id, changed),
    [sessions, id],
  );
  // The screen caches its rows until the next write, so they are a stable snapshot.
  const rows = useSyncExternalStore(subscribe, () => sessions.screen(id).rows());
  const exitCode = useSyncExternalStore(subscribe, () => sessions.exitCode(id));
  return { rows, exitCode };
}

/**
 * One interactive terminal: its screen plus a hidden input that turns key presses and paste
 * into PTY bytes. Click anywhere in it to type. Size follows the panel.
 */
export function TerminalView(props: { sessions: TerminalSessions; id: string; name: string }) {
  const { sessions, id } = props;
  const { rows, exitCode } = useSession(sessions, id);
  const input = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useResize(box, (cols, height) => sessions.resize(id, cols, height));
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const bytes = keyBytes(event);
    if (bytes === undefined) return;
    event.preventDefault();
    sessions.write(id, bytes);
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    sessions.write(id, event.clipboardData.getData("text").replace(/\r?\n/g, "\r"));
  };
  return (
    // The wrapper only forwards a click to the real input below; keyboard users tab to it.
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      ref={box}
      className="relative flex h-full min-h-0 flex-col"
      onClick={() => {
        if (!window.getSelection()?.toString()) input.current?.focus();
      }}
    >
      <ScreenRows rows={rows} label={`${props.name} output`} />
      {exitCode !== null && (
        <p className="px-4 pb-3 font-sans text-xs text-subtle-foreground">
          Process exited with code {exitCode}.
        </p>
      )}
      <textarea
        ref={input}
        aria-label={`${props.name} input`}
        disabled={exitCode !== null}
        value=""
        onChange={() => {}}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        className="absolute bottom-0 left-0 size-px resize-none overflow-hidden opacity-0"
      />
    </div>
  );
}

/** Report the cell grid the element fits (12px mono at 1.6 line height), as it changes. */
function useResize(
  box: React.RefObject<HTMLDivElement | null>,
  onResize: (cols: number, rows: number) => void,
) {
  const report = useEffectEvent(onResize);
  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let last = "";
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const cols = Math.max(20, Math.floor((entry.contentRect.width - 32) / 7.2));
      const rows = Math.max(4, Math.floor(entry.contentRect.height / 19.2));
      const size = `${cols}x${rows}`;
      if (size === last) return;
      last = size;
      report(cols, rows);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [box]);
}

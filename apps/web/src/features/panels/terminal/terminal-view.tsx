import { LongRows, type VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import { cn } from "@/lib/cn.ts";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import { applePlatform } from "@/lib/keymap.ts";
import { keyOwner } from "./keys.ts";
import type { Row, Style } from "./screen.ts";
import type { TerminalSessions } from "./sessions.ts";
import { terminalText, type TerminalSurface } from "./surface.ts";
import { canUseXterm, XtermView } from "./xterm-view.tsx";
import { terminalFont } from "./fonts.ts";

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
  cyan: "text-[var(--accent-teal)]",
};

/** Above this many rows a screen mounts only the rows near the viewport. */
const virtualAbove = 400;
const rowKey = (row: Row) => String(row.id);

/** A found match drawn over the screen: row index, then character offsets in that row. */
export interface ScreenMark {
  row: number;
  start: number;
  end: number;
}

const markClass = "rounded-[2px] bg-ring/38 text-foreground";

function ScreenRow(props: { row: Row; mark?: ScreenMark | undefined }) {
  const { mark, row } = props;
  // Where each segment starts in the row's text, to place a match across segments.
  const starts: number[] = [];
  let total = 0;
  for (const segment of row.segments) {
    starts.push(total);
    total += segment.text.length;
  }
  return (
    <div className="min-h-5 break-all">
      {row.segments.map((segment, index) => {
        const from = starts[index] ?? 0;
        const to = from + segment.text.length;
        const style = cn(
          segment.style.bold && "font-medium text-foreground",
          segment.style.dim && "text-subtle-foreground",
          segment.style.tone && tones[segment.style.tone],
        );
        const marked = mark && mark.end > from && mark.start < to;
        const start = marked ? Math.max(0, mark.start - from) : 0;
        const end = marked ? Math.min(segment.text.length, mark.end - from) : 0;
        return (
          // Segments have no identity of their own; their order within a row is it.
          // oxlint-disable-next-line react/no-array-index-key
          <span key={index} className={style}>
            {marked ? (
              <>
                {segment.text.slice(0, start)}
                <mark className={markClass}>{segment.text.slice(start, end)}</mark>
                {segment.text.slice(end)}
              </>
            ) : (
              segment.text
            )}
          </span>
        );
      })}
    </div>
  );
}

export const rowText = (row: Row) => row.segments.map((segment) => segment.text).join("");

/**
 * The rows of a screen, monospace, following output to the bottom unless scrolled up. `mark`
 * highlights a found match and scrolls it into view.
 */
export function ScreenRows(props: {
  rows: readonly Row[];
  label: string;
  className?: string;
  mark?: ScreenMark | undefined;
}) {
  const box = useRef<HTMLDivElement>(null);
  const virtual = useRef<VirtualRowsHandle>(null);
  const stick = useRef(true);
  const { rows, mark } = props;
  // The resolved monospace stack plus the symbol faces, read once from the font-mono class.
  useLayoutEffect(() => {
    const element = box.current;
    if (element) element.style.fontFamily = terminalFont(element);
  }, []);
  useLayoutEffect(() => {
    const element = box.current;
    // Scroll this box only (never its ancestors), once per redraw.
    if (stick.current && !mark && element && rows.length) element.scrollTop = element.scrollHeight;
  }, [rows, mark]);
  useLayoutEffect(() => {
    if (!mark) return;
    stick.current = false;
    virtual.current?.scrollToIndex(mark.row);
    box.current
      ?.querySelector(`[data-screen-row="${mark.row}"]`)
      ?.scrollIntoView?.({ block: "center" });
  }, [mark]);
  return (
    <div
      ref={box}
      role="log"
      aria-label={props.label}
      aria-live="off"
      onScroll={(event) => {
        const element = event.currentTarget;
        stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
      className={cn(
        "min-h-0 flex-1 overflow-auto px-3 pt-2 pb-3 font-mono text-ui leading-5 whitespace-pre-wrap text-muted-foreground",
        props.className,
      )}
    >
      <LongRows
        items={rows}
        virtualAbove={virtualAbove}
        rowKey={rowKey}
        estimate={terminalText.row}
        handle={virtual}
        render={(row, index) => (
          <div data-screen-row={index}>
            <ScreenRow row={row} mark={mark?.row === index ? mark : undefined} />
          </div>
        )}
      />
    </div>
  );
}

/** A surface over rows drawn by `ScreenRows` (no wrapping to undo: each row is a line). */
export function useScreenSurface(
  onSurface: (surface: TerminalSurface | null) => void,
  rows: readonly Row[],
  setMark: (mark: ScreenMark | undefined) => void,
  input?: { focus(): void; paste(text: string): void },
) {
  const latest = useRef(rows);
  useEffect(() => {
    latest.current = rows;
  });
  const report = useEffectEvent(onSurface);
  const focus = input?.focus;
  const paste = input?.paste;
  useEffect(() => {
    report({
      focus: () => focus?.(),
      text: () => {
        const lines = latest.current.map(rowText);
        return { lines, starts: lines.map((_, index) => index), columns: Number.MAX_SAFE_INTEGER };
      },
      reveal: (row, column, length) => setMark({ row, start: column, end: column + length }),
      unmark: () => setMark(undefined),
      selection: () => window.getSelection()?.toString() ?? "",
      selectAll: () => {},
      paste: (text) => paste?.(text),
    });
    return () => report(null);
  }, [setMark, focus, paste]);
}

function useSession(sessions: TerminalSessions, id: string) {
  const subscribe = useCallback(
    (changed: () => void) => sessions.watch(id, changed),
    [sessions, id],
  );
  // The screen caches its rows until the next write, so they are a stable snapshot.
  const rows = useSyncExternalStore(subscribe, () => sessions.screen(id).rows());
  return rows;
}

export interface TerminalViewProps {
  sessions: TerminalSessions;
  id: string;
  name: string;
  onSurface(surface: TerminalSurface | null): void;
  readOnly: boolean;
  autoFocus: boolean;
  onFind(): void;
}

/**
 * One interactive terminal: xterm with WebGL where the browser has it, the accessible DOM
 * screen otherwise. Click anywhere in it to type; its size follows the dock.
 */
export function TerminalView(props: TerminalViewProps) {
  const [xterm] = useState(canUseXterm);
  return xterm ? <XtermView {...props} /> : <DomTerminalView {...props} />;
}

/** The DOM screen with a hidden input that turns key presses and paste into PTY bytes. */
function DomTerminalView(props: TerminalViewProps) {
  const { sessions, id } = props;
  const rows = useSession(sessions, id);
  const input = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [mark, setMark] = useState<ScreenMark>();
  const focus = useCallback(() => input.current?.focus(), []);
  const paste = useCallback(
    (text: string) => sessions.write(id, text.replace(/\r?\n/g, "\r")),
    [sessions, id],
  );
  useScreenSurface(props.onSurface, rows, setMark, { focus, paste });
  useResize(box, (cols, height) => sessions.resize(id, cols, height));
  const autoFocus = useEffectEvent(() => props.autoFocus);
  useEffect(() => {
    if (autoFocus()) focus();
  }, [focus]);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const owner = keyOwner(event, applePlatform);
    if (owner === "find") {
      event.preventDefault();
      props.onFind();
      return;
    }
    if (owner !== "terminal") return;
    event.stopPropagation();
    const bytes = keyBytes(event);
    if (bytes === undefined) return;
    event.preventDefault();
    sessions.write(id, bytes);
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    paste(event.clipboardData.getData("text"));
  };
  return (
    // The wrapper only forwards a click to the real input below; keyboard users tab to it.
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      ref={box}
      className="relative flex h-full min-h-0 flex-col"
      onClick={() => {
        if (!window.getSelection()?.toString()) focus();
      }}
    >
      <ScreenRows rows={rows} label={`${props.name} output`} mark={mark} />
      <textarea
        ref={input}
        aria-label={`${props.name} input`}
        disabled={props.readOnly}
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

/** Report the cell grid the element fits (13px mono on 20px rows), as it changes. */
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
      const cols = Math.max(20, Math.floor((entry.contentRect.width - 24) / 7.8));
      const rows = Math.max(4, Math.floor(entry.contentRect.height / terminalText.row));
      const size = `${cols}x${rows}`;
      if (size === last) return;
      last = size;
      report(cols, rows);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [box]);
}

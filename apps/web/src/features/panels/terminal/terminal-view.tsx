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
import { terminalKeyBytes } from "@ace/client/terminal-keys";
import { applePlatform } from "@/lib/keymap.ts";
import { keyOwner, lineEditBytes } from "./keys.ts";
import type { Row, Style } from "./screen.ts";
import type { TerminalSessions } from "./sessions.ts";
import type { TerminalSurface } from "./surface.ts";
import { canUseXterm, XtermView } from "./xterm-view.tsx";
import { defaultTerminalLook, type TerminalLook } from "./suit-terminal.ts";
import { lookFont, screenStyle, useTerminalLook, cellWidth } from "./terminal-look.ts";
import { themeFor } from "./xterm-theme.ts";

/** Bytes a key press sends to a PTY, or undefined when the key is not the terminal's. */
export function keyBytes(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
) {
  if (event.metaKey) return undefined;
  // The plain surface tracks no terminal modes; xterm encodes keys itself when it draws.
  return terminalKeyBytes(
    { key: event.key, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey },
    { applicationCursor: false },
  );
}

// Under a Suit's terminal the screen sets `--term-<hue>` (`screenStyle`); else the theme's hues.
const tones: Record<NonNullable<Style["tone"]>, string> = {
  red: "text-[var(--term-red,var(--status-failed))]",
  green: "text-[var(--term-green,var(--status-done))]",
  yellow: "text-[var(--term-yellow,var(--status-needs-you))]",
  blue: "text-[var(--term-blue,var(--status-working))]",
  magenta: "text-[var(--term-magenta,var(--status-waiting))]",
  cyan: "text-[var(--term-cyan,var(--syn-type))]",
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

const markClass =
  "rounded-[2px] bg-[var(--term-mark,color-mix(in_oklab,var(--ring)_38%,transparent))] text-[var(--term-ink,var(--foreground))]";

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
    <div className="min-h-(--term-row,1.25rem) break-all">
      {row.segments.map((segment, index) => {
        const from = starts[index] ?? 0;
        const to = from + segment.text.length;
        const style = cn(
          segment.style.bold && "font-medium text-[var(--term-ink,var(--foreground))]",
          segment.style.dim && "text-[var(--term-dim,var(--subtle-foreground))]",
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
 * highlights a found match and scrolls it into view. Under a Suit's terminal (`look`) it takes
 * the font, row height and colours xterm would draw with.
 */
export function ScreenRows(props: {
  rows: readonly Row[];
  label: string;
  className?: string;
  mark?: ScreenMark | undefined;
  look?: TerminalLook | undefined;
}) {
  const box = useRef<HTMLDivElement>(null);
  const virtual = useRef<VirtualRowsHandle>(null);
  const stick = useRef(true);
  const { rows, mark } = props;
  const look = props.look ?? defaultTerminalLook;
  // The resolved monospace stack plus the symbol faces, from the font-mono class; with a Suit's
  // terminal, its face, size and colours (resolved against what the box sits on) too.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const own = look === defaultTerminalLook;
    // Measured bare: the previous Suit's background must not count as what the box sits on.
    element.removeAttribute("style");
    const style = screenStyle(
      look,
      lookFont(element, look),
      own ? undefined : themeFor(element, look),
    );
    for (const [name, value] of Object.entries(style)) element.style.setProperty(name, value);
  }, [look]);
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
      data-part="terminal"
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
        estimate={look.row}
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
 * screen otherwise. Click anywhere in it to type; its size follows the panel.
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
  const look = useTerminalLook();
  const focus = useCallback(() => input.current?.focus(), []);
  const paste = useCallback(
    (text: string) => sessions.write(id, text.replace(/\r?\n/g, "\r")),
    [sessions, id],
  );
  useScreenSurface(props.onSurface, rows, setMark, { focus, paste });
  useResize(box, look, (cols, height) => sessions.resize(id, cols, height));
  const autoFocus = useEffectEvent(() => props.autoFocus);
  useEffect(() => {
    if (autoFocus()) focus();
  }, [focus]);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const line = lineEditBytes(event, applePlatform);
    if (line !== undefined) {
      event.stopPropagation();
      event.preventDefault();
      sessions.write(id, line);
      return;
    }
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
      <ScreenRows rows={rows} label={`${props.name} output`} mark={mark} look={look} />
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

/** Report the cell grid the element fits (13px mono on 20px rows, or the Suit's), as it changes. */
function useResize(
  box: React.RefObject<HTMLDivElement | null>,
  look: TerminalLook,
  onResize: (cols: number, rows: number) => void,
) {
  const report = useEffectEvent(onResize);
  const cell = useEffectEvent(() => ({ width: cellWidth(look), row: look.row }));
  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let last = "";
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, row } = cell();
      const cols = Math.max(20, Math.floor((entry.contentRect.width - 24) / width));
      const rows = Math.max(4, Math.floor(entry.contentRect.height / row));
      const size = `${cols}x${rows}`;
      if (size === last) return;
      last = size;
      report(cols, rows);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [box]);
}

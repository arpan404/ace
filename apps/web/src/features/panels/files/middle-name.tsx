import { cn } from "@/lib/cn.ts";
import { Highlighted } from "./highlighted-path.tsx";

/**
 * How many of a name's last characters always show when it is cut: its extension and a few
 * letters before it, so "pull-request-tabs.tsx" narrows to "pull-req…-tabs.tsx", never
 * "pull-request-ta…".
 */
export function nameTail(name: string): number {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.length - dot : 0;
  return Math.min(Math.max(0, name.length - 1), extension + 6);
}

/** `text` split where a cut in the middle goes: the head shrinks, the last `tail` stay. */
function split(text: string, tail: number) {
  const keep = Math.min(tail, Math.max(0, text.length - 1));
  return { head: text.slice(0, text.length - keep), end: text.slice(text.length - keep) };
}

/**
 * A file or folder name that loses its middle instead of its end when the row is too narrow,
 * with the letters a filter matched in full weight (`positions` index the whole path; the name
 * starts at `offset`). Pure CSS: the head truncates, the tail never does.
 */
export function MiddleName(props: {
  text: string;
  offset: number;
  positions: readonly number[];
  part?: string;
  className?: string;
}) {
  const { head, end } = split(props.text, nameTail(props.text));
  return (
    <span data-part={props.part} className={cn("flex min-w-0", props.className)}>
      <span className="min-w-0 truncate whitespace-pre">
        <Highlighted text={head} offset={props.offset} positions={props.positions} />
      </span>
      {end && (
        <span data-part="name-end" className="shrink-0 whitespace-pre">
          <Highlighted text={end} offset={props.offset + head.length} positions={props.positions} />
        </span>
      )}
    </span>
  );
}

/**
 * Plain text cut in the middle (a folder's path): the head gives way to "…" first and the last
 * `tail` characters stay. With no room even for them, the tail clips as well ("…/wor…"), so the
 * text is never cut off without a mark or dropped.
 */
export function MiddleText(props: {
  text: string;
  tail: number;
  part?: string;
  className?: string;
}) {
  const { head, end } = split(props.text, props.tail);
  return (
    <span data-part={props.part} className={cn("flex min-w-0 overflow-hidden", props.className)}>
      {/* The head keeps one character's room, enough for its "…". */}
      <span className="min-w-[1ch] truncate whitespace-pre">{head}</span>
      {/* Shrinks only once the head is spent: its share of any shortfall is tiny. */}
      {end && <span className="min-w-0 shrink-[0.001] truncate whitespace-pre">{end}</span>}
    </span>
  );
}

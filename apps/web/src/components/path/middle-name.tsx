import { useLayoutEffect, useState } from "react";
import { cn } from "@/lib/cn.ts";
import { endCut } from "./end-name.ts";
import { folderLabel } from "./folder-label.ts";
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
 * A tree row's name, cut at its end when the row is too narrow: "adapter-ac…" for a folder,
 * "workspace-ta….ts" for a file, whose extension always shows (`endCut`). Pure CSS.
 */
export function EndName(props: { text: string; kind: "file" | "folder"; className?: string }) {
  const { head, end } = endCut(props.text, props.kind);
  return (
    <span className={cn("flex min-w-0", props.className)}>
      <span className="min-w-0 truncate whitespace-pre">{head}</span>
      {end && (
        <span data-part="name-end" className="shrink-0 whitespace-pre">
          {end}
        </span>
      )}
    </span>
  );
}

/**
 * A folder beside a file name, in the form `folderLabel` picks for the room it has: whole leading
 * folders drop first, then "…/" and the nearest folder, then that name cut at its end; with no
 * room for 4 of its letters, nothing (the row's title keeps the path). Until it has measured, the
 * whole folder shows.
 */
export function FolderLabel(props: { folder: string; part?: string; className?: string }) {
  const [box, setBox] = useState<HTMLSpanElement | null>(null);
  const [label, setLabel] = useState<string | undefined>(undefined);
  const { folder } = props;
  useLayoutEffect(() => {
    if (!box || typeof ResizeObserver === "undefined") return;
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return;
    // Called on observe and on every resize: the label for the room the row leaves.
    const observer = new ResizeObserver(() => {
      // Built from its parts: the `font` shorthand reads empty where variants are set.
      const style = getComputedStyle(box);
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      context.letterSpacing = style.letterSpacing;
      setLabel(folderLabel(folder, box.clientWidth, (text) => context.measureText(text).width));
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [box, folder]);
  return (
    <span
      ref={setBox}
      data-part={props.part}
      className={cn("block min-w-0 flex-1 truncate whitespace-pre", props.className)}
    >
      {label ?? folder}
    </span>
  );
}

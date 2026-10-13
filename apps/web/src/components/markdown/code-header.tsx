import { CheckIcon, CopyIcon, FileCodeIcon, GitDiffIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

const copyClass = [
  "relative inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-xs text-subtle-foreground",
  "transition-[opacity,color,background-color] duration-(--motion-fast) hover:bg-accent hover:text-foreground",
  "focus-visible:outline-2 focus-visible:outline-ring data-copied:text-foreground",
  "group-hover/code:text-muted-foreground",
  "touch-hit pointer-coarse:h-8 pointer-coarse:px-2.5",
].join(" ");

/**
 * Copy for a fence: always there in the header's quietest ink, a step brighter while the block
 * is hovered, at tap size on touch. "Copied" is announced.
 */
function CopyCode(props: { copied: boolean; onCopy(): void }) {
  return (
    <>
      <button
        type="button"
        onClick={props.onCopy}
        aria-label={props.copied ? "Copied" : "Copy code"}
        data-copied={props.copied ? "" : undefined}
        className={copyClass}
      >
        {props.copied ? <CheckIcon aria-hidden size={13} /> : <CopyIcon aria-hidden size={13} />}
        {props.copied ? "Copied" : "Copy"}
      </button>
      <span role="status" className="sr-only">
        {props.copied ? "Copied to clipboard" : ""}
      </span>
    </>
  );
}

/**
 * A fence's header: the file it shows (or its language), a diff's +/− counts, the block's own
 * controls and Copy. The file name truncates from the left, so its name stays in view.
 */
export function CodeHeader(props: {
  file: string | undefined;
  lang: string | undefined;
  diff: { additions: number; deletions: number } | undefined;
  copied: boolean;
  onCopy(): void;
  children?: ReactNode;
}) {
  const Icon = props.diff ? GitDiffIcon : props.file ? FileCodeIcon : undefined;
  return (
    <figcaption className="flex h-8 min-w-0 items-center gap-2 pr-1.5 pl-3 text-xs text-subtle-foreground border-b border-border">
      {Icon && <Icon aria-hidden size={13} className="shrink-0" />}
      {props.file ? (
        <span
          title={props.file}
          className="min-w-0 truncate font-mono text-muted-foreground [direction:rtl]"
        >
          <bdi>{props.file}</bdi>
        </span>
      ) : (
        <span className="font-mono">{props.lang || "text"}</span>
      )}
      {props.diff && (
        <span className="shrink-0 font-mono tabular-nums">
          <span className="text-status-done">+{props.diff.additions}</span>{" "}
          <span className="text-status-failed">−{props.diff.deletions}</span>
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {props.children}
        <CopyCode copied={props.copied} onCopy={props.onCopy} />
      </span>
    </figcaption>
  );
}

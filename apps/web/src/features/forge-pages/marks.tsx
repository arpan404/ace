import type { CSSProperties } from "react";
import {
  CheckCircleIcon,
  CheckIcon,
  CircleDashedIcon,
  ClockIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  RecordIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { ForgeIssueRow, ForgePrRow } from "@ace/protocol";
import { PrAvatar } from "@/features/forge/index.ts";
import { cn } from "@/lib/cn.ts";

/*
 * GitHub's marks for a pull request or issue, in ace's status hues: open green, draft grey,
 * merged violet, closed red; issues open green, completed violet. Each carries its word for
 * assistive tech, never colour alone.
 */

const prTone = { open: "done", draft: "idle", merged: "waiting", closed: "failed" } as const;
export const prWords = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
} as const;

export function PrStateGlyph(props: {
  state: ForgePrRow["state"];
  conflicting?: boolean | undefined;
}) {
  const Glyph = props.state === "merged" ? GitMergeIcon : GitPullRequestIcon;
  return (
    <span
      data-tone={prTone[props.state]}
      title={
        props.conflicting ? `${prWords[props.state]}, conflicts with base` : prWords[props.state]
      }
      className="relative inline-flex shrink-0 text-(--tone-text)"
    >
      <Glyph aria-hidden size={16} />
      <span className="sr-only">{prWords[props.state]}</span>
      {props.conflicting && (
        <span
          data-tone="failed"
          className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full border border-background bg-(--tone)"
        >
          <span className="sr-only">, conflicts with base</span>
        </span>
      )}
    </span>
  );
}

export function IssueStateGlyph(props: { state: ForgeIssueRow["state"]; size?: number }) {
  const open = props.state === "open";
  const Glyph = open ? RecordIcon : CheckCircleIcon;
  return (
    <span
      data-tone={open ? "done" : "waiting"}
      title={open ? "Open" : "Closed"}
      className="inline-flex shrink-0 text-(--tone-text)"
    >
      <Glyph aria-hidden size={props.size ?? 16} />
      <span className="sr-only">{open ? "Open" : "Closed"}</span>
    </span>
  );
}

/** The state as GitHub's pill: glyph and word on the state's colour. */
export function StateBadge(
  props:
    | { kind: "pr"; state: ForgePrRow["state"] }
    | { kind: "issue"; state: ForgeIssueRow["state"] },
) {
  const tone =
    props.kind === "pr" ? prTone[props.state] : props.state === "open" ? "done" : "waiting";
  const word =
    props.kind === "pr" ? prWords[props.state] : props.state === "open" ? "Open" : "Closed";
  const Glyph =
    props.kind === "issue"
      ? props.state === "open"
        ? RecordIcon
        : CheckCircleIcon
      : props.state === "merged"
        ? GitMergeIcon
        : GitPullRequestIcon;
  return (
    <span
      data-tone={tone}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--tone)_18%,transparent)] px-2.5 text-xs font-medium text-(--tone-text)"
    >
      <Glyph aria-hidden size={14} />
      {word}
    </span>
  );
}

/** A label in its GitHub colour, tinted so it reads on light and dark surfaces alike. */
export function LabelPill(props: { name: string; color?: string | undefined }) {
  const color = props.color ? `#${props.color}` : undefined;
  const style: CSSProperties | undefined = color
    ? {
        backgroundColor: `color-mix(in oklab, ${color} 20%, transparent)`,
        borderColor: `color-mix(in oklab, ${color} 45%, transparent)`,
        color: `color-mix(in oklab, ${color} 55%, var(--foreground))`,
      }
    : undefined;
  return (
    <span
      style={style}
      className={cn(
        "inline-flex h-5 max-w-40 shrink-0 items-center truncate rounded-full border px-2 text-2xs font-medium",
        !color && "border-border text-muted-foreground",
      )}
    >
      {props.name}
    </span>
  );
}

const reviewMarks = {
  APPROVED: { icon: CheckCircleIcon, tone: "done", word: "Approved" },
  CHANGES_REQUESTED: { icon: XCircleIcon, tone: "failed", word: "Changes requested" },
  REVIEW_REQUIRED: { icon: CircleDashedIcon, tone: undefined, word: "Review required" },
} as const;

export function ReviewMark(props: { decision: ForgePrRow["reviewDecision"] }) {
  if (!props.decision) return null;
  const mark = reviewMarks[props.decision];
  const Icon = mark.icon;
  return (
    <span
      data-tone={mark.tone}
      title={mark.word}
      className={cn("inline-flex", mark.tone ? "text-(--tone-text)" : "text-muted-foreground")}
    >
      <Icon aria-hidden size={14} />
      <span className="sr-only">{mark.word}</span>
    </span>
  );
}

export function ChecksMark(props: { ci: ForgePrRow["ci"] }) {
  const mark =
    props.ci === "success"
      ? { icon: CheckIcon, tone: "done", word: "Checks passed" }
      : props.ci === "failure"
        ? { icon: XIcon, tone: "failed", word: "Checks failing" }
        : props.ci === "pending"
          ? { icon: ClockIcon, tone: "working", word: "Checks running" }
          : undefined;
  if (!mark) return null;
  const Icon = mark.icon;
  return (
    <span data-tone={mark.tone} title={mark.word} className="inline-flex text-(--tone-text)">
      <Icon aria-hidden size={14} weight={props.ci === "pending" ? "regular" : "bold"} />
      <span className="sr-only">{mark.word}</span>
    </span>
  );
}

/** Up to three people, overlapped, with the rest as "+N". */
export function Avatars(props: {
  people: readonly string[];
  avatars?: Record<string, string> | undefined;
  label: string;
}) {
  if (!props.people.length) return null;
  const shown = props.people.slice(0, 3);
  return (
    <span
      title={`${props.label}: ${props.people.join(", ")}`}
      className="inline-flex shrink-0 items-center -space-x-1.5"
    >
      <span className="sr-only">{`${props.label}: ${props.people.join(", ")}`}</span>
      {shown.map((person) => (
        <span key={person} aria-hidden className="inline-flex">
          <PrAvatar
            name={person}
            url={props.avatars?.[person]}
            className="size-5 min-w-5 ring-2 ring-background"
          />
        </span>
      ))}
      {props.people.length > shown.length && (
        <span aria-hidden className="pl-2 text-xs text-subtle-foreground tabular-nums">
          +{props.people.length - shown.length}
        </span>
      )}
    </span>
  );
}

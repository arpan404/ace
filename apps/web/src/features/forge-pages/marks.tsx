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
import { PersonAvatar as PrAvatar } from "@/components/person-avatar.tsx";
import { cn } from "@/lib/cn.ts";

import { prTone, prWords } from "@/components/forge-marks.tsx";

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

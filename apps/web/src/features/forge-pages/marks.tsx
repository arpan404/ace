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
import type { LocalCheckResult } from "@ace/ui-core";
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

/** GitHub's checks and the latest local check of the head, as one state. */
function checksState(
  ci: ForgePrRow["ci"],
  local: LocalCheckResult,
): "failure" | "pending" | "success" | undefined {
  if (ci === "failure" || local === "failed") return "failure";
  if (ci === "pending" || local === "running") return "pending";
  if (ci === "success" || local === "passed") return "success";
  return undefined;
}

const localWords = {
  failed: "local check failed",
  running: "local check running",
  passed: "local check passed",
};

export function ChecksMark(props: { ci: ForgePrRow["ci"]; local?: LocalCheckResult }) {
  const state = checksState(props.ci, props.local);
  const mark =
    state === "success"
      ? { icon: CheckIcon, tone: "done", word: "Checks passed" }
      : state === "failure"
        ? { icon: XIcon, tone: "failed", word: "Checks failing" }
        : state === "pending"
          ? { icon: ClockIcon, tone: "working", word: "Checks running" }
          : undefined;
  if (!mark) return null;
  const Icon = mark.icon;
  const word = props.local ? `${mark.word}, ${localWords[props.local]}` : mark.word;
  return (
    <span data-tone={mark.tone} title={word} className="inline-flex text-(--tone-text)">
      <Icon aria-hidden size={14} weight={state === "pending" ? "regular" : "bold"} />
      <span className="sr-only">{word}</span>
    </span>
  );
}

/** Up to three people side by side, a little apart, with the rest as "+N". */
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
      className="inline-flex shrink-0 items-center gap-1"
    >
      <span className="sr-only">{`${props.label}: ${props.people.join(", ")}`}</span>
      {shown.map((person) => (
        <span key={person} aria-hidden className="inline-flex">
          <PrAvatar name={person} url={props.avatars?.[person]} className="size-5 min-w-5" />
        </span>
      ))}
      {props.people.length > shown.length && (
        <span aria-hidden className="text-xs text-subtle-foreground tabular-nums">
          +{props.people.length - shown.length}
        </span>
      )}
    </span>
  );
}

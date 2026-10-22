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
import { checksMark, checksState, reviewMark, type LocalCheckResult } from "@ace/ui-core";
import { PersonAvatar as PrAvatar } from "@/components/person-avatar.tsx";
import { cn } from "@/lib/cn.ts";

import { prTone, prWords } from "@ace/ui-core";

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

const reviewIcons = {
  APPROVED: CheckCircleIcon,
  CHANGES_REQUESTED: XCircleIcon,
  REVIEW_REQUIRED: CircleDashedIcon,
} as const;

export function ReviewMark(props: { decision: ForgePrRow["reviewDecision"] }) {
  const mark = reviewMark(props.decision);
  if (!props.decision || !mark) return null;
  const Icon = reviewIcons[props.decision];
  const toned = mark.tone !== "idle";
  return (
    <span
      data-tone={toned ? mark.tone : undefined}
      title={mark.word}
      className={cn("inline-flex", toned ? "text-(--tone-text)" : "text-muted-foreground")}
    >
      <Icon aria-hidden size={14} />
      <span className="sr-only">{mark.word}</span>
    </span>
  );
}

export function ChecksMark(props: { ci: ForgePrRow["ci"]; local?: LocalCheckResult }) {
  const state = checksState(props.ci, props.local);
  const mark = checksMark(props.ci, props.local);
  if (!state || !mark) return null;
  const Icon = state === "success" ? CheckIcon : state === "failure" ? XIcon : ClockIcon;
  const word = mark.word;
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

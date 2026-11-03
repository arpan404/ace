import {
  CheckCircleIcon,
  CheckIcon,
  CircleDashedIcon,
  ClockIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { ForgeIssueRow, ForgePrRow } from "@ace/protocol";
import { checksMark, checksState, reviewMark, type LocalCheckResult } from "@ace/ui-core";
import { PersonAvatar as PrAvatar } from "@/components/person-avatar.tsx";
import { cn } from "@/lib/cn.ts";

import { prTone, prWords } from "@ace/ui-core";

/**
 * A row's state in words before its title, where the list doesn't already say it: "Draft"
 * quiet, "Merged" and "Closed" in their tone. An open pull request needs no word.
 */
export function PrStateWord(props: { state: ForgePrRow["state"] }) {
  if (props.state === "open") return null;
  const draft = props.state === "draft";
  return (
    <span
      data-tone={draft ? undefined : prTone[props.state]}
      className={cn("mr-1.5 font-normal", draft ? "text-muted-foreground" : "text-(--tone-text)")}
    >
      {prWords[props.state]}
    </span>
  );
}

/** An issue's state in words before its title: "Closed", quiet; an open one needs none. */
export function IssueStateWord(props: { state: ForgeIssueRow["state"] }) {
  if (props.state === "open") return null;
  return <span className="mr-1.5 font-normal text-muted-foreground">Closed</span>;
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

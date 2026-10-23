import type { ForgeIssueRow, ForgePrRow, ForgeRepository } from "@ace/protocol";
import {
  checksMark,
  issueStateMark,
  middleTruncateText,
  prStepLabels,
  prStepsForYou,
  prTone,
  prWords,
  reviewMark,
  waitingWord,
  workKey,
  type ForgeMark,
  type LinkedThread,
  type LinkedThreads,
  type RowStep,
} from "@ace/ui-core";
import type { Preview } from "./agents.ts";

/*
 * One pull request or issue row as the phone draws it: every word, tone and step decided by the
 * web's shared rules (`@ace/ui-core`), so Swift lays the row out and never re-derives its state.
 * Text is bounded for the bridge frame; ages travel as epoch ms for the phone's own clock.
 */

export interface ForgeLabelView {
  name: string;
  /** GitHub's colour as six hex digits, or null when GitHub gave none. */
  color: string | null;
}
export interface ForgeThreadView {
  id: string;
  title: string;
  needsYou: boolean;
}
export interface PrRowView {
  key: string;
  number: number;
  repository: ForgeRepository;
  title: string;
  url: string;
  state: ForgeMark;
  merged: boolean;
  /** GitHub found conflicts with the base branch. */
  conflicting: boolean;
  labels: ForgeLabelView[];
  review: ForgeMark | null;
  checks: ForgeMark | null;
  comments: number;
  additions: number | null;
  deletions: number | null;
  author: string;
  /** "head → base", each end kept when long. */
  branches: string | null;
  thread: ForgeThreadView | null;
  /** The step's word when it is the viewer's to take ("Review", "Merge"). */
  step: string | null;
  /** The step is the viewer's (the "Needs you" steps), so the row may ask for attention. */
  stepNeedsYou: boolean;
  /** What it waits on when it waits on someone else ("Checks running"). */
  quiet: string | null;
  updatedAt: number | null;
}
export interface IssueRowView {
  key: string;
  number: number;
  repository: ForgeRepository;
  title: string;
  url: string;
  state: ForgeMark;
  labels: ForgeLabelView[];
  comments: number;
  assignees: string[];
  author: string;
  milestone: string | null;
  thread: ForgeThreadView | null;
  updatedAt: number | null;
}
export interface ForgeGroupView<Row> {
  id: string;
  label: string;
  /** GitHub's total for the group once known. */
  count: number | null;
  rows: Row[];
}

const epoch = (at: string | undefined) => {
  const parsed = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

function labelsOf(
  names: readonly string[],
  colors: Record<string, string> | undefined,
  preview: Preview,
): ForgeLabelView[] {
  return names.slice(0, 20).map((name) => ({
    name: preview(name, 100),
    color: colors?.[name] ?? null,
  }));
}

function threadOf(thread: LinkedThread | undefined, preview: Preview): ForgeThreadView | null {
  return thread
    ? { id: thread.id, title: preview(thread.title, 200), needsYou: thread.needsYou }
    : null;
}

export const keyOf = (row: { ref: { repository: ForgeRepository; number: number } }) =>
  workKey(row.ref.repository, row.ref.number);

export function prRowView(
  row: ForgePrRow,
  step: RowStep,
  linked: LinkedThreads,
  preview: Preview,
): PrRowView {
  const label = step.step === "wait" ? undefined : prStepLabels[step.step];
  return {
    key: keyOf(row),
    number: row.ref.number,
    repository: row.ref.repository,
    title: preview(row.title, 400),
    url: row.url,
    state: { word: prWords[row.state], tone: prTone[row.state] },
    merged: row.state === "merged",
    conflicting: row.conflicting === true,
    labels: labelsOf(row.labels, row.labelColors, preview),
    review: reviewMark(row.reviewDecision) ?? null,
    checks: checksMark(row.ci, step.local) ?? null,
    comments: row.commentCount ?? 0,
    additions: row.additions ?? null,
    deletions: row.deletions ?? null,
    author: preview(row.author, 100),
    branches:
      row.headBranch && row.baseBranch
        ? `${middleTruncateText(row.headBranch, 32)} → ${middleTruncateText(row.baseBranch, 20)}`
        : null,
    thread: threadOf(linked.get(keyOf(row)), preview),
    step: label ?? null,
    stepNeedsYou: prStepsForYou.includes(step.step),
    quiet: step.step === "wait" ? (waitingWord(row, step.local) ?? null) : null,
    updatedAt: epoch(row.updatedAt),
  };
}

export function issueRowView(
  row: ForgeIssueRow,
  linked: LinkedThreads,
  preview: Preview,
): IssueRowView {
  return {
    key: keyOf(row),
    number: row.ref.number,
    repository: row.ref.repository,
    title: preview(row.title, 400),
    url: row.url,
    state: issueStateMark(row.state),
    labels: labelsOf(row.labels, row.labelColors, preview),
    comments: row.commentCount ?? 0,
    assignees: row.assignees.slice(0, 10).map((login) => preview(login, 100)),
    author: preview(row.author, 100),
    milestone: row.milestone ? preview(row.milestone, 200) : null,
    thread: threadOf(linked.get(keyOf(row)), preview),
    updatedAt: epoch(row.updatedAt),
  };
}

const sortedUnique = (values: readonly string[]) =>
  [...new Set(values)].toSorted((a, b) => a.localeCompare(b)).slice(0, 100);

/** Every author and label the rows carry, plus the ones already chosen, for the Filters menu. */
export function filterChoices(
  rows: readonly { author: string; labels: readonly string[] }[],
  chosen: { author?: string | undefined; labels?: readonly string[] | undefined },
): { authors: string[]; labels: string[] } {
  return {
    authors: sortedUnique([
      ...rows.map((row) => row.author),
      ...(chosen.author ? [chosen.author] : []),
    ]),
    labels: sortedUnique([...rows.flatMap((row) => row.labels), ...(chosen.labels ?? [])]),
  };
}

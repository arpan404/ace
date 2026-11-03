import {
  BellIcon,
  ChatCircleIcon,
  ChatsIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  LightningIcon,
  RecordIcon,
  RocketIcon,
  ShieldWarningIcon,
  XIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { ForgeInboxRow, ForgeIssueRow, ForgePrRow } from "@ace/protocol";
import {
  checksMark,
  checksState,
  inboxTypeWords,
  issueStateMark,
  prTone,
  prWords,
  type LocalCheckResult,
} from "@ace/ui-core";
import { PersonAvatar } from "@/components/person-avatar.tsx";
import { cn } from "@/lib/cn.ts";

/** A row's leading mark, 16px, in its tone, with its word for assistive tech. */
function StateIcon(props: { icon: Icon; tone: string; word: string }) {
  const Glyph = props.icon;
  return (
    <span
      data-tone={props.tone}
      title={props.word}
      className={cn(
        "inline-flex shrink-0",
        props.tone === "idle" ? "text-muted-foreground" : "text-(--tone-text)",
      )}
    >
      <Glyph aria-hidden size={16} weight={props.icon === RecordIcon ? "bold" : "regular"} />
      <span className="sr-only">{props.word}</span>
    </span>
  );
}

/** A pull request's state as GitHub draws it: open green, draft grey, merged violet, closed red. */
export function PrStateIcon(props: { state: ForgePrRow["state"] }) {
  return (
    <StateIcon
      icon={props.state === "merged" ? GitMergeIcon : GitPullRequestIcon}
      tone={prTone[props.state]}
      word={prWords[props.state]}
    />
  );
}

/** An issue's state: open green, closed violet (completed). */
export function IssueStateIcon(props: { state: ForgeIssueRow["state"] }) {
  const mark = issueStateMark(props.state);
  return (
    <StateIcon
      icon={props.state === "open" ? RecordIcon : CheckCircleIcon}
      tone={mark.tone}
      word={mark.word}
    />
  );
}

const typeIcons: Record<string, Icon> = {
  Discussion: ChatsIcon,
  Release: RocketIcon,
  Commit: GitCommitIcon,
  CheckSuite: LightningIcon,
  RepositoryVulnerabilityAlert: ShieldWarningIcon,
  RepositoryDependabotAlertsThread: ShieldWarningIcon,
};

/**
 * A notification's subject: a pull request's or issue's own state mark when GitHub said its
 * state, else its type's mark, quiet.
 */
export function InboxTypeIcon(props: { row: ForgeInboxRow }) {
  const { row } = props;
  if (row.type === "PullRequest")
    return row.state ? (
      <PrStateIcon state={row.state} />
    ) : (
      <StateIcon icon={GitPullRequestIcon} tone="idle" word={inboxTypeWords(row.type)} />
    );
  if (row.type === "Issue")
    return row.state === "open" || row.state === "closed" ? (
      <IssueStateIcon state={row.state} />
    ) : (
      <StateIcon icon={RecordIcon} tone="idle" word={inboxTypeWords(row.type)} />
    );
  return (
    <StateIcon icon={typeIcons[row.type] ?? BellIcon} tone="idle" word={inboxTypeWords(row.type)} />
  );
}

/** The checks' outcome after a title: ✓ green, ✗ red, • amber while running. */
export function ChecksMark(props: { ci: ForgePrRow["ci"]; local?: LocalCheckResult }) {
  const state = checksState(props.ci, props.local);
  const mark = checksMark(props.ci, props.local);
  if (!state || !mark) return null;
  const Glyph = state === "success" ? CheckIcon : state === "failure" ? XIcon : ClockIcon;
  return (
    <span
      data-tone={mark.tone}
      title={mark.word}
      className="inline-flex shrink-0 align-[-2px] text-(--tone-text)"
    >
      <Glyph aria-hidden size={14} weight={state === "pending" ? "regular" : "bold"} />
      <span className="sr-only">{mark.word}</span>
    </span>
  );
}

/**
 * Labels as pills in their own colour: a wash of it behind, the colour mixed toward the text so
 * it reads on any theme. A label without a colour is a plain hairline pill.
 */
export function LabelPills(props: {
  names: readonly string[];
  colors?: Readonly<Record<string, string>> | undefined;
}) {
  return (
    <>
      {props.names.map((name) => {
        const color = props.colors?.[name];
        return (
          <span
            key={name}
            style={
              color
                ? {
                    color: `color-mix(in oklab, #${color} 55%, var(--foreground))`,
                    backgroundColor: `color-mix(in oklab, #${color} 18%, transparent)`,
                    borderColor: `color-mix(in oklab, #${color} 45%, transparent)`,
                  }
                : undefined
            }
            className={cn(
              "ml-1 inline-flex h-[18px] max-w-48 shrink-0 items-center truncate rounded-full border px-[7px] align-[1px] text-xs leading-none font-medium",
              !color && "border-border text-muted-foreground",
            )}
          >
            {name}
          </span>
        );
      })}
    </>
  );
}

/** A speech bubble and the count, at a row's right; nothing for none. */
export function CommentCount(props: { count: number | undefined }) {
  if (!props.count) return null;
  const words = `${props.count} ${props.count === 1 ? "comment" : "comments"}`;
  return (
    <span
      title={words}
      className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums"
    >
      <ChatCircleIcon aria-hidden size={16} />
      <span aria-hidden>{props.count}</span>
      <span className="sr-only">{words}</span>
    </span>
  );
}

/** Up to three people, overlapping a little, with the rest as "+N". */
export function Avatars(props: {
  people: readonly string[];
  avatars?: Record<string, string> | undefined;
  label: string;
}) {
  if (!props.people.length) return null;
  const shown = props.people.slice(0, 3);
  const words = `${props.label}: ${props.people.join(", ")}`;
  return (
    <span title={words} className="inline-flex shrink-0 items-center">
      <span className="sr-only">{words}</span>
      {shown.map((person, index) => (
        <span
          key={person}
          aria-hidden
          className={cn("inline-flex rounded-full ring-2 ring-background", index > 0 && "-ml-1.5")}
        >
          <PersonAvatar name={person} url={props.avatars?.[person]} className="size-5 min-w-5" />
        </span>
      ))}
      {props.people.length > shown.length && (
        <span aria-hidden className="ml-1 text-xs text-muted-foreground tabular-nums">
          +{props.people.length - shown.length}
        </span>
      )}
    </span>
  );
}

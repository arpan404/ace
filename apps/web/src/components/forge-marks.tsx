import type { CSSProperties } from "react";
import {
  CheckCircleIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  RecordIcon,
} from "@phosphor-icons/react";
import { prTone, prWords, type IssueState, type PrState } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";

/*
 * GitHub's marks for a pull request or issue, in ace's status hues: open green, draft grey,
 * merged violet, closed red; issues open green, completed violet. Each carries its word, never
 * colour alone (words and tones from `@ace/ui-core`). Shared by the Pull requests view's lists and
 * pages and by the PR view.
 */

/** The state as GitHub's pill: glyph and word on the state's colour. */
export function StateBadge(
  props: { kind: "pr"; state: PrState } | { kind: "issue"; state: IssueState },
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

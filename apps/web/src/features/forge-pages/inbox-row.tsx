import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowSquareOutIcon,
  BellIcon,
  ChatsCircleIcon,
  EnvelopeSimpleIcon,
  GitCommitIcon,
  PlayCircleIcon,
  ShieldWarningIcon,
  TagIcon,
} from "@phosphor-icons/react";
import type { ForgeInboxRow } from "@ace/protocol";
import { inboxReasonWords, inboxTarget, inboxTypeWords } from "@ace/ui-core";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import { IssueStateGlyph, PrStateGlyph } from "./marks.tsx";
import { Age, rowClass } from "./row-parts.tsx";

const typeGlyphs: Record<string, IconGlyph> = {
  Release: TagIcon,
  Discussion: ChatsCircleIcon,
  Commit: GitCommitIcon,
  CheckSuite: PlayCircleIcon,
  RepositoryVulnerabilityAlert: ShieldWarningIcon,
  RepositoryDependabotAlertsThread: ShieldWarningIcon,
  RepositoryInvitation: EnvelopeSimpleIcon,
};

/** The subject's mark: a PR's or issue's state glyph in its hue, else its type, quiet. */
function SubjectGlyph(props: { row: ForgeInboxRow }) {
  const { row } = props;
  if (row.type === "PullRequest" && row.state) return <PrStateGlyph state={row.state} />;
  if (row.type === "Issue" && (row.state === "open" || row.state === "closed"))
    return <IssueStateGlyph state={row.state} />;
  const words = inboxTypeWords(row.type);
  return (
    <span title={words} className="inline-flex shrink-0 text-faint-foreground">
      <Icon icon={typeGlyphs[row.type] ?? BellIcon} />
      <span className="sr-only">{words}</span>
    </span>
  );
}

/** Where the row goes: ace's PR or issue page, else nothing (it opens on GitHub). */
export interface InboxRowTarget {
  project: string;
  /** The repository in the address when it isn't the project's own. */
  repo: string | undefined;
  /** The list's address, so the page can come back to it. */
  back: string;
}

/**
 * One notification at GitHub's density: the unread dot in the gutter, the subject's state or
 * type, number and title, then its repository and why it arrived, and how long ago. Opening it
 * marks it read. Hover or focus shows Mark read, Mark done and Unsubscribe (which also marks it
 * done).
 */
export function InboxRow(props: {
  row: ForgeInboxRow;
  to: InboxRowTarget;
  onOpenWeb(url: string): void;
  onWrite(action: "read" | "done" | "unsubscribe"): void;
}) {
  const { row, to } = props;
  const target = inboxTarget(row);
  const markRead = () => {
    if (row.unread) props.onWrite("read");
  };
  const body: ReactNode = (
    <>
      {row.unread && (
        <span
          aria-hidden
          className="absolute top-[18px] left-[calc(var(--forge-gutter)/2-3px)] size-1.5 rounded-full bg-ring"
        />
      )}
      <span className="pt-0.5">
        <SubjectGlyph row={row} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          {row.unread && <span className="sr-only">Unread,</span>}
          {row.number !== undefined && (
            <span className="shrink-0 font-mono text-xs text-subtle-foreground tabular-nums">
              #{row.number}
            </span>
          )}
          <span
            data-view-row-title=""
            className={cn(
              "min-w-0 truncate text-ui",
              row.unread ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {row.title}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
          <span className="truncate">
            {row.repository.owner}/{row.repository.name}
          </span>
          <span aria-hidden className="text-subtle-foreground">
            ·
          </span>
          <span className="shrink-0">{inboxReasonWords(row.reason)}</span>
          {target.kind === "web" && inboxTypeWords(row.type) !== inboxReasonWords(row.reason) && (
            <>
              <span aria-hidden className="text-subtle-foreground">
                ·
              </span>
              <span className="shrink-0 text-subtle-foreground">{inboxTypeWords(row.type)}</span>
            </>
          )}
          <span className="ml-auto pl-2 text-subtle-foreground">
            <Age at={row.updatedAt} />
          </span>
        </span>
      </span>
    </>
  );
  return (
    <li className="group/row relative border-b border-border last:border-b-0">
      {target.kind === "web" ? (
        <button
          type="button"
          data-view-row=""
          className={rowClass}
          onClick={() => {
            markRead();
            props.onOpenWeb(target.url);
          }}
        >
          {body}
        </button>
      ) : (
        <Link
          to={target.kind === "pull" ? "/pulls/$project/$number" : "/issues/$project/$number"}
          params={{ project: to.project, number: String(target.number) }}
          search={{ back: to.back, ...(to.repo ? { repo: to.repo } : {}) }}
          data-view-row=""
          className={rowClass}
          onClick={markRead}
        >
          {body}
        </Link>
      )}
      <span className="absolute top-1.5 right-[calc(var(--forge-gutter)-0.5rem)] hidden items-center gap-0.5 rounded-md bg-hover group-focus-within/row:flex group-hover/row:flex">
        {row.unread && (
          <Button size="xs" variant="ghost" onClick={() => props.onWrite("read")}>
            Mark read
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={() => props.onWrite("done")}>
          Mark done
        </Button>
        <Button size="xs" variant="ghost" onClick={() => props.onWrite("unsubscribe")}>
          Unsubscribe
        </Button>
        {row.url && (
          <IconButton
            size="sm"
            icon={ArrowSquareOutIcon}
            label="Open on GitHub"
            onClick={() => props.onOpenWeb(row.url ?? "")}
          />
        )}
      </span>
    </li>
  );
}

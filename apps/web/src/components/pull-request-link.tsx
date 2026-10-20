import { useThreadMeta } from "@ace/client-react";
import { prFromUrl } from "@ace/forge/pr-reference";
import type { ForgePrRef } from "@ace/protocol";
import { createContext, useContext, type MouseEvent, type ReactNode } from "react";
import { pullRequestTab, useWorkspaceActions } from "@/lib/workspace/index.ts";

/*
 * A link to a pull request opens it in a side panel tab rather than on the forge. Inside a pull
 * request's own tab, links go to that panel (`PullRequestOpener`); in a thread's answer, to the
 * thread's panel. It stays a real link: its address copies, a modified or middle click still
 * opens the forge in the browser, and so does any click with nowhere in ace to open it.
 */

type OpenPullRequest = (pr: ForgePrRef) => void;

/** Where links to a pull request open, for everything drawn inside it (a PR tab provides it). */
export const PullRequestOpener = createContext<OpenPullRequest | undefined>(undefined);

/** The pull request a GitHub address names (`…/pull/12`, `…/pull/12/files`), else undefined. */
export function pullRequestAt(href: string): ForgePrRef | undefined {
  try {
    return prFromUrl(href);
  } catch {
    return undefined;
  }
}

/** A plain click; a modified or middle click keeps the browser's own meaning (a new tab). */
const plainClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

type LinkProps = {
  href: string;
  pr: ForgePrRef;
  className?: string | undefined;
  children: ReactNode;
};

function OpeningLink(props: LinkProps & { open: OpenPullRequest | undefined }) {
  const { open, pr } = props;
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer noopener"
      className={props.className}
      onClick={(event) => {
        if (!open || event.defaultPrevented || !plainClick(event)) return;
        event.preventDefault();
        open(pr);
      }}
    >
      {props.children}
    </a>
  );
}

function ThreadLink(props: LinkProps & { threadId: string }) {
  const workspaceId = useThreadMeta(props.threadId)?.workspaceId;
  const actions = useWorkspaceActions(props.threadId);
  const open = workspaceId
    ? (pr: ForgePrRef) =>
        actions.open(pullRequestTab({ workspaceId, repository: pr.repository, number: pr.number }))
    : undefined;
  return <OpeningLink {...props} open={open} />;
}

/**
 * A link to pull request `pr`: it opens in the enclosing PR tab's panel when there is one, else
 * in thread `threadId`'s side panel, else on the forge.
 */
export function PullRequestLink(props: LinkProps & { threadId?: string | undefined }) {
  const opener = useContext(PullRequestOpener);
  if (opener || !props.threadId) return <OpeningLink {...props} open={opener} />;
  return <ThreadLink {...props} threadId={props.threadId} />;
}

import { useThreadMeta } from "@ace/client-react";
import type { ForgePrRef } from "@ace/protocol";
import { useContext, type MouseEvent, type ReactNode } from "react";
import { pullRequestTab, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { PullRequestOpener, WebLink } from "./web-link.tsx";

/*
 * A link to a pull request opens it in a side panel tab rather than on the forge. Inside a pull
 * request's own tab, links go to that panel (`PullRequestOpener`); in a thread's answer, to the
 * thread's panel. It stays a real link: its address copies, and a ⌘/Ctrl or middle click opens
 * the forge in the system's browser. Any click with nowhere in ace to show the PR opens the
 * forge as any web link does (`WebLink`).
 */

type OpenPullRequest = (pr: ForgePrRef) => void;

export { PullRequestOpener, pullRequestAt } from "./web-link.tsx";

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
    <WebLink
      href={props.href}
      className={props.className}
      onClick={(event) => {
        if (!open || event.defaultPrevented || !plainClick(event)) return;
        event.preventDefault();
        open(pr);
      }}
    >
      {props.children}
    </WebLink>
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

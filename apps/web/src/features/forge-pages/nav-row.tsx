import { GitPullRequestIcon, TrayIcon } from "@phosphor-icons/react";
import { prStepsForYou, workKey, rowStep, prQuery } from "@ace/ui-core";
import { NavRow } from "@/components/nav-row.tsx";
import { useVerifyRuns } from "@/lib/verify.ts";
import { useLinkedThreads } from "./linked-threads.ts";
import { useInboxPages } from "./inbox-data.ts";
import { usePrPages } from "./lists.ts";
import { useProjectChoice } from "./project-choice.ts";

/**
 * The sidebar's "Pull requests" row with its needs-you dot: lit while an open PR of the project
 * last looked at waits on the person (a review asked of them, failing checks or conflicts on
 * their PR, an agent waiting), by the same next-step rule as the list. It reads the list's own
 * first page, cached and kept between sessions, so it costs no extra GitHub read.
 */
export function PullRequestsNavRow(props: { active: boolean }) {
  const choice = useProjectChoice(undefined);
  const project = choice.project;
  const list = usePrPages(project, prQuery({}, 1), 1);
  const linked = useLinkedThreads().pulls;
  const runs = useVerifyRuns(project).data?.runs ?? [];
  const viewer = list.first?.viewer;
  const waiting = list.rows.filter((row) =>
    prStepsForYou.includes(
      rowStep(row, viewer, linked.get(workKey(row.ref.repository, row.ref.number)), runs).step,
    ),
  ).length;
  const counts = list.first?.counts;
  return (
    <NavRow
      to="/pulls"
      icon={GitPullRequestIcon}
      label="Pull requests"
      active={props.active}
      needsYou={waiting}
      open={counts && counts.open + counts.draft}
    />
  );
}

/**
 * The sidebar's "Inbox" row with a quiet count of unread GitHub notifications. It reads the
 * inbox's first page, the same read the page polls, so the count keeps up while the app is open
 * at no extra cost; it never lights the needs-you dot or notifies the OS.
 */
export function InboxNavRow(props: { active: boolean }) {
  const choice = useProjectChoice(undefined);
  const list = useInboxPages(choice.project, {}, 1);
  const unread = list.rows.filter((row) => row.unread).length;
  return <NavRow to="/inbox" icon={TrayIcon} label="Inbox" active={props.active} open={unread} />;
}

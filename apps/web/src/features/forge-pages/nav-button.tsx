import { prStepsForYou, workKey, rowStep, prQuery } from "@ace/ui-core";
import { ForgeButton } from "@/components/forge-button.tsx";
import { useVerifyRuns } from "@/lib/verify.ts";
import { useLinkedThreads } from "./linked-threads.ts";
import { useInboxPages } from "./inbox-data.ts";
import { useLastListPath } from "./last-list.ts";
import { usePrPages } from "./lists.ts";
import { useReviewSources } from "./review-sources.ts";
import { inboxProjects, rowsForProjects } from "./inbox-model.ts";
import { useInboxRepositories } from "./inbox-projects.ts";
import { useProjectChoice } from "./project-choice.ts";

/**
 * Code review's place in the rail with what it knows: how many open pull requests of the projects
 * the lists show wait on the person (a review asked of them, failing checks or conflicts on
 * their PR, an agent waiting), by the same next-step rule as the list, and how many inbox
 * notifications are unread. Both come from the lists' own first pages, cached and kept between
 * sessions, so the button costs no extra GitHub read.
 */
export function ForgeNavButton(props: { active: boolean }) {
  const choice = useProjectChoice({});
  const list = usePrPages(useReviewSources(choice.projects).sources, prQuery({}, 1), 1);
  const inbox = useInboxPages(choice.all[0], {}, 1);
  const projectOf = inboxProjects(useInboxRepositories(choice.all).repositories);
  const linked = useLinkedThreads().pulls;
  const runs = useVerifyRuns(choice.one).data?.runs ?? [];
  const viewer = list.first?.viewer;
  const waiting = list.rows.filter((row) =>
    prStepsForYou.includes(
      rowStep(row, viewer, linked.get(workKey(row.ref.repository, row.ref.number)), runs).step,
    ),
  ).length;
  const unread = rowsForProjects(inbox.rows, choice.picked, projectOf).filter(
    (row) => row.unread,
  ).length;
  return (
    <ForgeButton to={useLastListPath()} active={props.active} needsYou={waiting} unread={unread} />
  );
}

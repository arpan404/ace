import type { z } from "zod";
import type { ForgeLifecycleSnapshot, ForgeLockReason } from "@ace/protocol/forge-lifecycle";
import type { ForgeRepository } from "@ace/protocol/forge";
import type { LifecycleExtras } from "./github-lifecycle-schemas.ts";
import { writeRoles, type LifecycleExtraFacts } from "./lifecycle-plan.ts";

type Extras = z.infer<typeof LifecycleExtras>["data"]["repository"];
type Mapped = Pick<
  ForgeLifecycleSnapshot,
  "milestone" | "conversation" | "headBranch" | "closingIssues"
>;

const reasons: Record<string, ForgeLockReason> = {
  OFF_TOPIC: "off_topic",
  TOO_HEATED: "too_heated",
  RESOLVED: "resolved",
  SPAM: "spam",
};

/** An issue's identity whatever the case of its repository's name. */
const issueKey = (owner: string, name: string, number: number) =>
  `${owner.toLowerCase()}/${name.toLowerCase()}#${number}`;

/** The milestone, lock, head branch and closing issues a newer host reports, as ace shows them. */
export function mapLifecycleExtras(
  repository: ForgeRepository,
  extras: Extras,
  permission: string | null,
  number: number,
): { fields: Mapped; facts: LifecycleExtraFacts } {
  const pr = extras.pullRequest;
  const manual = new Set(
    pr.manualClosingIssues.nodes.flatMap((node) =>
      node ? [issueKey(node.repository.owner.login, node.repository.name, node.number)] : [],
    ),
  );
  const closingIssues = pr.closingIssuesReferences.nodes.flatMap((node) =>
    node
      ? [
          {
            ref: {
              repository: {
                ...repository,
                owner: node.repository.owner.login,
                name: node.repository.name,
              },
              number: node.number,
            },
            title: node.title,
            state: node.state === "CLOSED" ? ("closed" as const) : ("open" as const),
            url: node.url,
            manual: manual.has(
              issueKey(node.repository.owner.login, node.repository.name, node.number),
            ),
          },
        ]
      : [],
  );
  const facts: LifecycleExtraFacts = {
    locked: pr.locked,
    headExists: pr.headRef !== null,
    sameRepository: !pr.isCrossRepository,
    isDefault: extras.defaultBranchRef?.name === pr.headRefName,
    deleteOnMerge: extras.deleteBranchOnMerge,
    // GitHub's one flag covers both: it may delete the head branch, or restore it once deleted.
    canRestoreHead: pr.viewerCanDeleteHeadRef,
    openPrsUsingBranch: (pr.headRef?.associatedPullRequests.nodes ?? []).flatMap((node) =>
      node && node.number !== number ? [node.number] : [],
    ),
  };
  return {
    facts,
    fields: {
      milestone: pr.milestone
        ? {
            number: pr.milestone.number,
            title: pr.milestone.title,
            state: pr.milestone.state === "CLOSED" ? "closed" : "open",
            dueOn: pr.milestone.dueOn,
          }
        : null,
      conversation: {
        locked: pr.locked,
        reason: pr.locked ? (reasons[pr.activeLockReason ?? ""] ?? null) : null,
        // GitHub keeps a locked conversation open to collaborators who can push.
        viewerCanComment: !pr.locked || writeRoles.includes(permission ?? ""),
      },
      headBranch: {
        name: pr.headRefName,
        exists: facts.headExists,
        sameRepository: facts.sameRepository,
        isDefault: facts.isDefault,
        deleteOnMerge: facts.deleteOnMerge,
        usedBy: [...facts.openPrsUsingBranch],
      },
      closingIssues,
    },
  };
}

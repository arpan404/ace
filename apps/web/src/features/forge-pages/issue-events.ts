import { z } from "zod";

/** The parts of a timeline record a line names; anything else in it is left alone. */
const Subject = z.looseObject({
  label: z
    .looseObject({ name: z.string().max(256) })
    .optional()
    .catch(undefined),
  assignee: z
    .looseObject({ login: z.string().max(256) })
    .optional()
    .catch(undefined),
  milestone: z
    .looseObject({ title: z.string().max(256) })
    .optional()
    .catch(undefined),
  rename: z
    .looseObject({ from: z.string().max(65_536), to: z.string().max(65_536) })
    .optional()
    .catch(undefined),
  state_reason: z.string().max(64).nullable().optional().catch(undefined),
});

/** Activity GitHub records that its own page hides too: who was notified, not what happened. */
const hidden = new Set(["mentioned", "subscribed", "unsubscribed"]);

export interface IssueEventInput {
  event: string;
  raw: unknown;
  pullRequestUrl?: string | undefined;
}

/**
 * What a timeline record says after its actor's name ("added the bug label"), or undefined for
 * one the timeline leaves out. An event ace has no words for still shows, by its own name.
 */
export function issueEventText(input: IssueEventInput): string | undefined {
  if (hidden.has(input.event)) return undefined;
  const subject = Subject.safeParse(input.raw);
  const s = subject.success ? subject.data : {};
  switch (input.event) {
    case "closed":
      return s.state_reason === "not_planned" ? "closed this as not planned" : "closed this";
    case "reopened":
      return "reopened this";
    case "labeled":
      return s.label ? `added the ${s.label.name} label` : "added a label";
    case "unlabeled":
      return s.label ? `removed the ${s.label.name} label` : "removed a label";
    case "assigned":
      return s.assignee ? `assigned ${s.assignee.login}` : "assigned someone";
    case "unassigned":
      return s.assignee ? `unassigned ${s.assignee.login}` : "unassigned someone";
    case "milestoned":
      return s.milestone ? `added this to ${s.milestone.title}` : "added this to a milestone";
    case "demilestoned":
      return s.milestone ? `removed this from ${s.milestone.title}` : "removed the milestone";
    case "renamed":
      return s.rename ? `changed the title from "${s.rename.from}"` : "changed the title";
    case "cross-referenced":
      return input.pullRequestUrl ? "mentioned this in a pull request" : "mentioned this";
    case "referenced":
      return "referenced this in a commit";
    case "connected":
      return "linked a pull request";
    case "locked":
      return "locked the conversation";
    case "unlocked":
      return "unlocked the conversation";
    default:
      return input.event.replaceAll(/[-_]/g, " ");
  }
}

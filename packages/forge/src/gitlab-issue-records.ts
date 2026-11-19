import { z } from "zod";
import { ForgeRepository } from "@ace/protocol/forge";
import { ForgeIssueEvent, ForgeIssueRow } from "@ace/protocol/forge-issues";
import { ForgeError } from "./errors.ts";
import { decode, type Headers } from "./gitlab-records.ts";
import { clipLabels, clipText } from "./host-text.ts";
import { prUrl } from "./pr-reference.ts";
import { redactData } from "./redact.ts";

/*
 * GitLab issues and notes as docs.gitlab.com/api/issues/ and docs.gitlab.com/api/notes/ report
 * them. Unknown fields are kept in `raw`; a state rows can't express is dropped, never guessed.
 */

export const GitLabUser = z.looseObject({
  id: z.number().int().positive(),
  username: z.string().min(1).max(256),
});
/** A label is a name, or with `with_labels_details=true` an object carrying its colour. */
const Label = z.union([
  z.string(),
  z.looseObject({ name: z.string(), color: z.string().max(64).nullable().optional() }),
]);
export const GitLabIssue = z.looseObject({
  iid: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable().optional(),
  state: z.string().max(32),
  author: GitLabUser.nullable().optional(),
  labels: z.array(Label).max(1000).default([]),
  assignees: z.array(GitLabUser).max(1000).default([]),
  milestone: z
    .looseObject({ id: z.number().int().positive(), title: z.string() })
    .nullable()
    .optional(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  user_notes_count: z.number().int().nonnegative().optional(),
  confidential: z.boolean().optional(),
  discussion_locked: z.boolean().nullable().optional(),
});
export type GitLabIssue = z.infer<typeof GitLabIssue>;
export const GitLabNote = z.looseObject({
  id: z.number().int().positive(),
  body: z.string(),
  author: GitLabUser.nullable().optional(),
  created_at: z.string().nullable().optional(),
  system: z.boolean().default(false),
});
const access = z.looseObject({ access_level: z.number().int() }).nullable().optional();
export const GitLabProject = z.looseObject({
  archived: z.boolean().optional(),
  issues_enabled: z.boolean().optional(),
  issues_access_level: z.string().max(32).optional(),
  permissions: z
    .looseObject({ project_access: access, group_access: access })
    .nullable()
    .optional(),
});
export type GitLabProject = z.infer<typeof GitLabProject>;

/** An issue's web address from the repository under read, never the server's `web_url`. */
export function issueUrl(repository: ForgeRepository, iid: number): string {
  return `https://${repository.host}/${repository.owner}/${repository.name}/-/issues/${iid}`;
}

/** Issues can be opened, closed, commented on and edited in the project. */
export function issuesEnabled(project: GitLabProject): boolean {
  return (
    project.archived !== true &&
    project.issues_enabled !== false &&
    project.issues_access_level !== "disabled"
  );
}

/** The viewer's role in the project: 15 Planner and above may triage any issue. */
export function accessLevel(project: GitLabProject): number {
  const levels = project.permissions;
  return Math.max(
    levels?.project_access?.access_level ?? 0,
    levels?.group_access?.access_level ?? 0,
  );
}

function labelName(label: z.infer<typeof Label>): string {
  return typeof label === "string" ? label : label.name;
}

/** A row, or null for a state GitLab may add later, which no row can express honestly. */
export function issueRow(repository: ForgeRepository, record: GitLabIssue): ForgeIssueRow | null {
  if (record.state !== "opened" && record.state !== "closed") return null;
  const colors: Record<string, string> = {};
  for (const label of record.labels) {
    const color =
      typeof label === "string" ? undefined : /^#?([0-9a-f]{6})$/i.exec(label.color ?? "");
    if (color?.[1]) colors[clipText(labelName(label))] = color[1];
  }
  const parsed = ForgeIssueRow.safeParse({
    ref: { repository, number: record.iid },
    title: clipText(record.title),
    url: issueUrl(repository, record.iid),
    author: clipText(record.author?.username ?? "deleted user"),
    state: record.state === "opened" ? "open" : "closed",
    labels: clipLabels(record.labels.map(labelName)),
    assignees: record.assignees.slice(0, 100).map((user) => clipText(user.username)),
    milestone: record.milestone ? clipText(record.milestone.title) : null,
    createdAt: clipText(record.created_at),
    updatedAt: clipText(record.updated_at),
    ...(Object.keys(colors).length ? { labelColors: colors } : {}),
    ...(record.user_notes_count === undefined ? {} : { commentCount: record.user_notes_count }),
    raw: redactData(record),
  });
  if (!parsed.success) throw new ForgeError("invalid_data");
  return parsed.data;
}

/** `!N` or `group/project!N` in a system note such as "mentioned in merge request !12". */
const mergeRequestMention = /\bmerge request (?:([\w.-]+(?:\/[\w.-]+)+))?!([1-9]\d*)\b/;

/** The merge request a system note names, on the same host; `#N` names issues, never MRs. */
function mentionedMergeRequest(repository: ForgeRepository, body: string): string | undefined {
  const match = mergeRequestMention.exec(body);
  if (!match) return undefined;
  const path = match[1];
  const named = path
    ? ForgeRepository.safeParse({
        ...repository,
        owner: path.slice(0, path.lastIndexOf("/")),
        name: path.slice(path.lastIndexOf("/") + 1),
      })
    : { success: true as const, data: repository };
  return named.success ? prUrl({ repository: named.data, number: Number(match[2]) }) : undefined;
}

/** A user note is a comment; a system note ("changed the description", "closed") is activity. */
export function noteEvent(
  repository: ForgeRepository,
  iid: number,
  note: z.infer<typeof GitLabNote>,
): z.infer<typeof ForgeIssueEvent> {
  const body = clipText(note.body);
  const mention = note.system ? mentionedMergeRequest(repository, note.body) : undefined;
  return decode(ForgeIssueEvent, {
    id: String(note.id),
    kind: note.system ? "activity" : "issue_comment",
    event: note.system ? "system_note" : "commented",
    actor: clipText(note.author?.username ?? "GitLab"),
    at: note.created_at ? clipText(note.created_at) : null,
    body,
    url: `${issueUrl(repository, iid)}#note_${note.id}`,
    ...(mention ? { pullRequestUrl: mention } : {}),
    raw: redactData(note),
  });
}

/** `x-total`, when GitLab counted (it stops past 10,000 rows). */
export function totalHeader(headers: Headers): number | undefined {
  const value = headers["x-total"]?.trim();
  if (value === undefined || !/^\d{1,15}$/.test(value)) return undefined;
  return Number(value);
}

/** Whether a page has a successor: `x-next-page` when sent, else the total, else a full page. */
export function hasNextPage(headers: Headers, page: number, size: number, rows: number): boolean {
  const next = headers["x-next-page"];
  if (next !== undefined) return next.trim() !== "";
  const total = totalHeader(headers);
  return total === undefined ? rows === size : page * size < total;
}

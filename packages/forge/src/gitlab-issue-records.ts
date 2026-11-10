import { z } from "zod";
import type { ForgeRepository } from "@ace/protocol/forge";
import { ForgeIssueRow } from "@ace/protocol/forge-issues";
import { ForgeError } from "./errors.ts";
export const IssueUser = z.looseObject({ id: z.number().int().positive(), username: z.string(), avatar_url: z.string().nullable().optional() });
export const Issue = z.looseObject({
  iid: z.number().int().positive(), title: z.string(), description: z.string().nullable().optional(),
  state: z.enum(["opened", "closed"]), author: IssueUser.nullable(),
  labels: z.array(z.string()), assignees: z.array(IssueUser),
  milestone: z.looseObject({ id: z.number().int().positive(), title: z.string() }).nullable(),
  created_at: z.string(), updated_at: z.string(), user_notes_count: z.number().int().nonnegative().optional(),
  confidential: z.boolean().optional(), discussion_locked: z.boolean().nullable().optional(),
});
export const Note = z.looseObject({ id: z.number().int().positive(), body: z.string(),
  author: IssueUser.nullable(), created_at: z.string(), system: z.boolean() });
export const Project = z.looseObject({ archived: z.boolean(), issues_enabled: z.boolean().optional(),
  issues_access_level: z.string().optional(), permissions: z.looseObject({
    project_access: z.looseObject({ access_level: z.number() }).nullable().optional(),
    group_access: z.looseObject({ access_level: z.number() }).nullable().optional(),
  }).optional() });
export function decode<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ForgeError("invalid_data");
  return parsed.data;
}
export function issueUrl(repository: ForgeRepository, number: number) {
  return `https://${repository.host}/${repository.owner}/${repository.name}/-/issues/${number}`;
}
export function issueRow(repository: ForgeRepository, record: z.infer<typeof Issue>) {
  return ForgeIssueRow.parse({ ref: { repository, number: record.iid }, title: record.title,
    url: issueUrl(repository, record.iid), author: record.author?.username ?? "deleted user",
    state: record.state === "opened" ? "open" : "closed", labels: record.labels,
    assignees: record.assignees.map(user => user.username), milestone: record.milestone?.title ?? null,
    createdAt: record.created_at, updatedAt: record.updated_at,
    ...(record.author?.avatar_url ? { authorAvatarUrl: record.author.avatar_url } : {}),
    commentCount: record.user_notes_count, raw: record });
}
export function totalHeader(headers: Record<string, string>): number | undefined {
  const value = headers["x-total"];
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const total = Number(value);
  return Number.isSafeInteger(total) ? total : undefined;
}
export function morePages(headers: Record<string, string>, page: number, size: number, length: number) {
  if (headers["x-next-page"] !== undefined) return headers["x-next-page"] !== "";
  const total = totalHeader(headers);
  return total === undefined ? length === size : page * size < total;
}

import { createHash } from "node:crypto";
import { z } from "zod";
import { ForgeLifecycleSnapshot } from "@ace/protocol/forge-lifecycle";
import type { ForgeRepository } from "@ace/protocol/forge";
import { Mr, headOf, requireSha, statusState } from "./gitlab-records.ts";
import { ForgeError } from "./errors.ts";

export const LifecycleMr = Mr.extend({
  id: z.number().int().positive(),
  target_branch: z.string().min(1),
  assignees: z.array(z.looseObject({ username: z.string() })).max(100),
  discussion_locked: z.boolean().nullable().optional(),
  milestone: z
    .looseObject({ id: z.number().int().positive(), iid: z.number().int().positive() })
    .nullable()
    .optional(),
});
export const LifecycleProject = z.looseObject({
  archived: z.boolean(),
  permissions: z
    .looseObject({
      project_access: z.looseObject({ access_level: z.number() }).nullable().optional(),
      group_access: z.looseObject({ access_level: z.number() }).nullable().optional(),
    })
    .optional(),
});
/** Only permission evidence supplied by GitLab adds controls. Unknown roles grant nothing. */
export function gitLabLifecycleSnapshot(
  repository: ForgeRepository,
  raw: z.infer<typeof LifecycleMr>,
  project: z.infer<typeof LifecycleProject>,
): ForgeLifecycleSnapshot {
  const state = statusState(raw);
  if (state === "unknown") throw new ForgeError("unsupported");
  const canEdit =
    !project.archived &&
    Math.max(
      project.permissions?.project_access?.access_level ?? 0,
      project.permissions?.group_access?.access_level ?? 0,
    ) >= 30;
  const active = state === "open" || state === "draft";
  const metadata = {
    title: raw.title,
    body: raw.description ?? "",
    baseBranch: raw.target_branch,
    labels: (raw.labels ?? []).toSorted(),
    assignees: raw.assignees.map((u) => u.username).toSorted(),
    ...(raw.milestone === undefined ? {} : { milestone: raw.milestone?.iid ?? null }),
  };
  const actions: ForgeLifecycleSnapshot["actions"] = canEdit
    ? [
        ...(active
          ? ["close" as const, state === "draft" ? ("ready" as const) : ("draft" as const)]
          : []),
        ...(state === "closed" ? ["reopen" as const] : []),
        ...(raw.discussion_locked === undefined
          ? []
          : [raw.discussion_locked ? ("unlock" as const) : ("lock" as const)]),
      ]
    : [];
  return ForgeLifecycleSnapshot.parse({
    pr: { repository, number: raw.iid },
    id: String(raw.id),
    version: createHash("sha256").update(JSON.stringify({ raw, project })).digest("hex"),
    headSha: requireSha(headOf(raw)),
    baseSha: requireSha(raw.diff_refs?.base_sha ?? ""),
    state,
    metadata,
    actions,
    editableFields:
      canEdit && state !== "merged"
        ? ["title", "body", "labels", "assignees", ...(active ? ["baseBranch"] : [])]
        : [],
    unsupported: [
      "update.merge",
      "update.rebase",
      "revert",
      "branch.delete",
      "branch.restore",
      "issue.link",
      "issue.unlink",
    ],
    ...(raw.discussion_locked === undefined
      ? {}
      : {
          conversation: {
            locked: raw.discussion_locked === true,
            reason: null,
            viewerCanComment: canEdit || raw.discussion_locked !== true,
          },
        }),
  });
}

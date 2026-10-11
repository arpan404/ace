import { z } from "zod";
const text = z.string().max(65_536);
const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
const info = z.object({ hasNextPage: z.boolean() });
export const LifecyclePr = z.looseObject({
  id: text,
  number: z.number().int().positive(),
  title: text,
  body: text,
  state: text,
  isDraft: z.boolean(),
  headRefOid: sha,
  baseRefOid: sha,
  baseRefName: text,
  updatedAt: text,
  mergeCommit: z.looseObject({ oid: sha }).nullable(),
  viewerCanUpdate: z.boolean(),
  viewerCanClose: z.boolean(),
  viewerCanReopen: z.boolean(),
  viewerCanUpdateBranch: z.boolean(),
  viewerCanLabel: z.boolean(),
  viewerCanAssign: z.boolean(),
  canBeRebased: z.boolean(),
  labels: z.object({
    nodes: z.array(z.looseObject({ id: text, name: text })).max(100),
    pageInfo: info,
  }),
  assignees: z.object({
    nodes: z.array(z.looseObject({ id: text, login: text })).max(100),
    pageInfo: info,
  }),
});
export const LifecycleHost = z.object({
  data: z.object({
    repository: z.object({
      isArchived: z.boolean(),
      viewerPermission: text.nullable(),
      pullRequest: LifecyclePr,
    }),
  }),
});
export const SupportedMutations = z.object({
  data: z.object({
    mutationType: z.object({ fields: z.array(z.object({ name: text })).max(1000) }),
  }),
});
export const lifecyclePrFields = `id number title body state isDraft headRefOid baseRefOid baseRefName updatedAt mergeCommit { oid } viewerCanUpdate viewerCanClose viewerCanReopen viewerCanUpdateBranch viewerCanLabel viewerCanAssign canBeRebased labels(first:100){ nodes { id name } pageInfo { hasNextPage } } assignees(first:100){ nodes { id login } pageInfo { hasNextPage } }`;

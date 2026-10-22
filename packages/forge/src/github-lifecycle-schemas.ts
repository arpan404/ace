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
const owner = z.looseObject({ login: text });
const closing = z.looseObject({
  nodes: z
    .array(
      z
        .looseObject({
          number: z.number().int().positive(),
          title: text,
          state: text,
          url: text,
          repository: z.looseObject({ name: text, owner }),
        })
        .nullable(),
    )
    .max(50),
  pageInfo: info,
});
/**
 * Facts newer hosts add to the snapshot: milestone, lock, head branch and closing issues. A
 * host that refuses them still answers the base snapshot, without these controls.
 */
export const LifecycleExtras = z.object({
  data: z.object({
    repository: z.looseObject({
      deleteBranchOnMerge: z.boolean(),
      defaultBranchRef: z.looseObject({ name: text }).nullable(),
      pullRequest: z.looseObject({
        milestone: z
          .looseObject({
            number: z.number().int().positive(),
            title: text,
            state: text,
            dueOn: text.nullable(),
          })
          .nullable(),
        locked: z.boolean(),
        activeLockReason: text.nullable(),
        headRefName: text,
        headRef: z.looseObject({ name: text }).nullable(),
        isCrossRepository: z.boolean(),
        viewerCanDeleteHeadRef: z.boolean(),
        closingIssuesReferences: closing,
        manualClosingIssues: closing,
      }),
    }),
  }),
});
export const lifecycleExtraRepositoryFields = `deleteBranchOnMerge defaultBranchRef { name }`;
const closingFields = `nodes { number title state url repository { name owner { login } } } pageInfo { hasNextPage }`;
export const lifecycleExtraPrFields = `milestone { number title state dueOn } locked activeLockReason headRefName headRef { name } isCrossRepository viewerCanDeleteHeadRef closingIssuesReferences(first:50){ ${closingFields} } manualClosingIssues:closingIssuesReferences(first:50,userLinkedOnly:true){ ${closingFields} }`;

import type { ForgePrStatus, ForgeComment, ForgeCheck } from "@ace/protocol/forge";
import { CollectionVersions } from "./incremental.ts";
export const commentIdentity = (comment: ForgeComment) => `${comment.kind}:${comment.id}`;
export const checkIdentity = (check: ForgeCheck) => check.id;
/** Instance-owned non-owning metadata. Callers may retain explicit collection deltas. */
export class StatusRevisions {
  readonly comments = new CollectionVersions<ForgeComment>();
  readonly checks = new CollectionVersions<ForgeCheck>();
  readonly threads = new CollectionVersions<ForgePrStatus["reviewThreads"][number]>();
}

import { accessRank } from "@ace/provider-kit/access-modes";
import { AccessMode, type AccessRequest, type Thread } from "@ace/protocol";

/**
 * A remote child's access: an explicit mode the remote agent supports and no broader than the
 * parent's, or on inherit the broadest supported mode at or below it. Undefined refuses.
 */
export function remoteChildAccess(
  parent: AccessMode | null,
  requested: AccessRequest | undefined,
  offered: readonly AccessMode[],
): AccessMode | undefined {
  if (parent === null) return undefined;
  const within = offered.filter((mode) => accessRank(mode) <= accessRank(parent));
  if (requested !== undefined && requested !== "inherit")
    return within.includes(requested) ? requested : undefined;
  return within.reduce<AccessMode | undefined>(
    (best, mode) => (!best || accessRank(mode) > accessRank(best) ? mode : best),
    undefined,
  );
}

/** A running remote child stays within its parent, including a stricter pending change. */
export function remoteAccessHolds(
  parent: AccessMode | null,
  thread: Pick<Thread, "permission"> | undefined,
  child: AccessMode,
): boolean {
  if (parent === null) return false;
  const pending = AccessMode.safeParse(thread?.permission?.override);
  const ceiling =
    pending.success && accessRank(pending.data) < accessRank(parent) ? pending.data : parent;
  return accessRank(child) <= accessRank(ceiling);
}

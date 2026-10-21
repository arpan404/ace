/*
 * Revision conflicts in plain words. The daemon refuses a stale write with
 * "Automation revision conflict" (and create-only with "Automation already exists",
 * or a missing id with "Automation is missing"). These stay pure: an unknown error
 * reads its message, never its shape.
 */

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "";
}

const has = (error: unknown, pattern: RegExp): boolean => pattern.test(messageOf(error));

/** A stale CAS write: another device (or a background refetch) moved the revision first. */
export function isRevisionConflict(error: unknown): boolean {
  return has(error, /revision conflict/i);
}

/** Create-only (`expectedRevision: null`) while the id is live. */
export function isAlreadyExists(error: unknown): boolean {
  return has(error, /already exists/i);
}

/** The id is gone: deleted elsewhere, or never created. */
export function isMissingAutomation(error: unknown): boolean {
  return has(error, /is missing|no longer exists|not found/i);
}

export function isStaleWrite(error: unknown): boolean {
  return isRevisionConflict(error) || isAlreadyExists(error);
}

/**
 * What happened, then what to do. No codes, no exclamation marks.
 * Callers refetch the list after showing this.
 */
export function staleWriteMessage(error: unknown): string {
  if (isRevisionConflict(error))
    return "This automation changed elsewhere. Reload to see the latest, then try again.";
  if (isAlreadyExists(error))
    return "This automation was recreated elsewhere. Reload to see it, then try again.";
  if (isMissingAutomation(error))
    return "That automation no longer exists. It may have been deleted on another device.";
  if (error instanceof Error && error.message) return error.message;
  return "Couldn't save this automation. Check its fields and try again.";
}

/** Deleting a revision that already moved on: keep the row, say why. */
export function staleDeleteMessage(error: unknown): string {
  if (isRevisionConflict(error))
    return "This automation changed elsewhere. Reload to see the latest before deleting.";
  return staleWriteMessage(error);
}

import type { PosixOperation } from "./posix-wire.ts";

/** A command folder's call failed without an answer: it stopped responding, or was cancelled. */
export class CommandFilesystemUnavailable extends Error {}
/** A change timed out or was given up mid-call: it may still land, or may have landed. */
export class CommandWriteOutcomeUnknown extends CommandFilesystemUnavailable {
  /** The root whose thread may still apply it. */
  readonly root: string;
  constructor(message: string, root: string) {
    super(message);
    this.root = root;
  }
}
/** The outcome-unknown error behind `error`, following causes. */
export function writeOutcomeUnknown(error: unknown): CommandWriteOutcomeUnknown | undefined {
  for (let at = error, depth = 0; at instanceof Error && depth < 8; depth++) {
    if (at instanceof CommandWriteOutcomeUnknown) return at;
    at = at.cause;
  }
  return undefined;
}

const changes = new Set<PosixOperation["op"]>([
  "create",
  "rename",
  "link",
  "unlink",
  "mkdir",
  "symlink",
  "renameFlags",
  "write",
  "fsync",
  "chmod",
]);
/** Calls that change a folder; they wait while an earlier change on the root may still land. */
export const isChange = (operation: PosixOperation) => changes.has(operation.op);
/** Calls that end ownership. They are never refused, cancelled or dropped. */
export const isRelease = (operation: PosixOperation) =>
  operation.op === "closeFd" || operation.op === "closeDirectory";

/**
 * The descriptors a call reads through. Each belongs to the call until it has returned natively,
 * answered or abandoned and then returned, so no one may close it before then.
 */
export function inputsOf(operation: PosixOperation): number[] {
  switch (operation.op) {
    case "open":
    case "create":
    case "readLink":
    case "mkdir":
    case "unlink":
    case "symlink":
      return operation.directory >= 0 ? [operation.directory] : [];
    case "rename":
    case "link":
    case "renameFlags":
      return operation.from === operation.to ? [operation.from] : [operation.from, operation.to];
    case "fstat":
    case "read":
    case "write":
    case "fsync":
    case "chmod":
      return [operation.fd];
    default:
      return [];
  }
}
/**
 * The descriptor a call takes over once sent: fdopendir's stream owns it, and the worker closes
 * it if fdopendir fails. A call that never reaches a thread leaves it to the lanes to close.
 */
export const consumedBy = (operation: PosixOperation): number | undefined =>
  operation.op === "openDirectory" ? operation.fd : undefined;

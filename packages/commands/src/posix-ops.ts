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
  "mkdirPath",
]);
/** Calls that change a folder; they wait while an earlier change on the root may still land. */
export const isChange = (operation: PosixOperation) => changes.has(operation.op);
/** Closing a handle. Never refused or cancelled; a no-op once its worker is gone. */
export const isRelease = (operation: PosixOperation) => operation.op === "close";

/** The existing handles a call names; all must belong to one live worker. */
export function handlesOf(operation: PosixOperation): number[] {
  switch (operation.op) {
    case "open":
      return operation.directory > 0 ? [operation.directory] : [];
    case "create":
    case "readLink":
    case "mkdir":
    case "unlink":
    case "symlink":
      return [operation.directory];
    case "rename":
    case "link":
    case "renameFlags":
      return operation.from === operation.to ? [operation.from] : [operation.from, operation.to];
    case "openDirectory":
    case "fstat":
    case "read":
    case "write":
    case "fsync":
    case "chmod":
      return [operation.fd];
    case "readDirectory":
      return [operation.reader];
    case "close":
      return [operation.handle];
    default:
      return [];
  }
}
/** The handle a call creates, owned by the worker that runs it if the call succeeds. */
export function createdBy(operation: PosixOperation): number | undefined {
  switch (operation.op) {
    case "open":
    case "create":
    case "openPath":
      return operation.handle;
    case "openDirectory":
      return operation.stream;
    default:
      return undefined;
  }
}
/** Whether a call that answered `value` created its handle. */
export const created = (operation: PosixOperation, value: unknown) =>
  operation.op === "openDirectory" ? value === 1 : value === 0;
/** openDirectory takes its descriptor over once sent; it is gone whatever the outcome. */
export const consumedBy = (operation: PosixOperation): number | undefined =>
  operation.op === "openDirectory" ? operation.fd : undefined;

import { CommandFilesystemUnavailable } from "./posix-ops.ts";
import type { PosixLanes } from "./posix-lanes.ts";
import type { PosixOperation, PosixValue } from "./posix-wire.ts";

/**
 * The calls of one user of command folders (one discovery, one prompt edit). Cancelling stops
 * only this owner: its queued calls fail at once and a running one is released when it returns,
 * while other owners' calls on the same roots carry on in order. Its handles can be closed
 * right after cancelling: a close goes to the owning thread, after the call still running there.
 */
export class PosixCallOwner {
  private readonly lanes: PosixLanes;
  private readonly controller = new AbortController();
  constructor(lanes: PosixLanes) {
    this.lanes = lanes;
  }
  run(root: string, operation: PosixOperation): Promise<{ value: PosixValue }> {
    return this.lanes.run(root, operation, { signal: this.controller.signal });
  }
  cleanup(): PosixLanes {
    return this.lanes;
  }
  cancel(): void {
    this.controller.abort(new CommandFilesystemUnavailable("Command files closed"));
  }
}

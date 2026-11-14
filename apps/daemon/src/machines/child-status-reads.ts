import type { MachineThreadView, ThreadId } from "@ace/protocol";
import { refusedNotFound } from "./transport.ts";

/** Reads children's views from their machine, sixteen at most per call. */
export type StatusCall = (
  machine: string,
  parentThreadId: ThreadId,
  ids: readonly ThreadId[],
) => Promise<MachineThreadView[]>;

/**
 * What one read learnt: the views that came back, children the machine says it doesn't hold,
 * and children whose read failed (the machine couldn't be reached or the connection was lost),
 * each with its error. Views answered are kept whatever happens to the other reads.
 */
export interface StatusRead {
  views: MachineThreadView[];
  unknown: { id: ThreadId; error: unknown }[];
  failed: { id: ThreadId; error: unknown }[];
}

/**
 * Status reads in which one child the machine holds no record of (`not_found`, refused for the
 * whole call) never stops the others being read. A refused call is split into one read per
 * child, and children found unknown are asked alone from then on, so later calls aren't refused
 * and split again; one is asked with the others again once a read of it alone answers. A read
 * that fails for any other reason fails only the children it asked: what earlier reads in the
 * same pass answered is returned and applied.
 */
export class StatusReads {
  private call: StatusCall;
  /** Children the machine said it doesn't hold, by machine. */
  private unknown = new Map<string, Set<string>>();
  constructor(call: StatusCall) {
    this.call = call;
  }
  async read(machine: string, parent: ThreadId, ids: readonly ThreadId[]): Promise<StatusRead> {
    const known = this.unknown.get(machine);
    const alone = ids.filter((id) => known?.has(id));
    const together = ids.filter((id) => !known?.has(id));
    const result: StatusRead = { views: [], unknown: [], failed: [] };
    if (together.length > 0) {
      try {
        result.views.push(...(await this.call(machine, parent, together)));
      } catch (error) {
        if (refusedNotFound(error)) alone.push(...together);
        else for (const id of together) result.failed.push({ id, error });
      }
    }
    for (const id of alone) {
      try {
        result.views.push(...(await this.call(machine, parent, [id])));
        known?.delete(id);
      } catch (error) {
        if (!refusedNotFound(error)) {
          result.failed.push({ id, error });
          continue;
        }
        result.unknown.push({ id, error });
        const set = this.unknown.get(machine) ?? new Set<string>();
        set.add(id);
        this.unknown.set(machine, set);
      }
    }
    return result;
  }
}

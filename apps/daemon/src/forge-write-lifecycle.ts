import { ForgeError } from "@ace/forge";

/** Only a known refusal or a failure before dispatch authorizes a new write. */
export function writeFailureState(error: unknown, dispatched: boolean): "failed" | "uncertain" {
  return !dispatched ||
    (error instanceof ForgeError &&
      ["not_found", "forbidden", "rate_limit", "conflict", "unsupported"].includes(error.kind))
    ? "failed"
    : "uncertain";
}

/** Read-only reconciliation shares the same resource lock as mutations. */
export class ForgeWriteFlights {
  private active = new Map<string, string>();
  has(resource: string): boolean {
    return this.active.has(resource);
  }
  hasOperation(id: string): boolean {
    return [...this.active.values()].includes(id);
  }
  acquire(resource: string, id: string): boolean {
    if (this.active.has(resource) || this.active.size >= 16) return false;
    this.active.set(resource, id);
    return true;
  }
  release(resource: string): void {
    this.active.delete(resource);
  }
}

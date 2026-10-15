import type { CommandResult, CommandStatusState } from "@ace/protocol";

/**
 * The commands a fake host has run, per device, across every socket: the ones still working and
 * the result of each one that finished. `command.status` reads it the way the daemon reads its
 * command lanes and stored receipts.
 */
export class CommandFlights {
  #running = new Set<string>();
  #results = new Map<string, CommandResult>();
  /** Track `work` as running for `deviceId` until it settles, then keep its result. */
  run(deviceId: string, commandId: string, work: () => Promise<CommandResult>) {
    const key = flightKey(deviceId, commandId);
    this.#running.add(key);
    const result = work();
    // Bookkeeping on the side, so the caller sees the result as soon as it would have.
    result.then(
      (settled) => {
        this.#running.delete(key);
        this.#results.set(key, settled);
      },
      () => this.#running.delete(key),
    );
    return result;
  }
  /** A command that answered at once. */
  record(deviceId: string, result: CommandResult): void {
    this.#results.set(flightKey(deviceId, result.commandId), result);
  }
  /**
   * Running while its work is in flight; settled with its result once one exists; unknown when
   * this device never ran it here.
   */
  status(
    deviceId: string,
    commandId: string,
  ): { state: CommandStatusState; result?: CommandResult } {
    const key = flightKey(deviceId, commandId);
    if (this.#running.has(key)) return { state: "running" };
    const result = this.#results.get(key);
    return result ? { state: "settled", result } : { state: "unknown" };
  }
}

const flightKey = (deviceId: string, commandId: string) => `${deviceId}\u0000${commandId}`;

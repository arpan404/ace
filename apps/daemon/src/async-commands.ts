import { actionErrorCode } from "./action-errors.ts";
import { commandNotDispatched } from "./command-not-dispatched.ts";
import type { Command, CommandResult } from "@ace/protocol";
import type { Store } from "./store.ts";

/** Reserve before I/O, share concurrent retries, and never repeat an uncertain external effect. */
export class AsyncCommands {
  private store: Store;
  private flights = new Map<
    string,
    { deviceId: Command["deviceId"]; promise: Promise<CommandResult> }
  >();
  constructor(store: Store) {
    this.store = store;
  }
  run(
    command: Command,
    effect: () => Promise<Omit<CommandResult, "commandId">>,
  ): Promise<CommandResult> {
    const existing = this.flights.get(command.id);
    if (existing)
      return existing.deviceId === command.deviceId
        ? existing.promise
        : Promise.resolve(commandNotDispatched(command, "forbidden"));
    // Capacity cannot turn a replay of an already admitted write into an unsent refusal.
    let previous: CommandResult | undefined;
    try {
      previous = this.store.commandReceipt(command.id, command.deviceId);
    } catch {
      return Promise.resolve({
        commandId: command.id,
        ok: false,
        error: "action_outcome_uncertain",
      });
    }
    if (previous)
      return Promise.resolve(
        previous.error === "client_action_pending"
          ? { commandId: command.id, ok: false, error: "action_outcome_uncertain" }
          : previous,
      );
    if (this.flights.size >= 16)
      return Promise.resolve(commandNotDispatched(command, "action_busy"));
    let reserved = false;
    let receipt: CommandResult;
    try {
      receipt = this.store.recordCommand(command.id, command.deviceId, () => {
        reserved = true;
        return { commandId: command.id, ok: false, error: "client_action_pending" };
      });
    } catch (error) {
      return Promise.resolve(commandNotDispatched(command, actionErrorCode(error)));
    }
    if (!reserved && !this.store.commandReceipt(command.id, command.deviceId))
      return Promise.resolve(commandNotDispatched(command, "forbidden"));
    if (!reserved && receipt.error !== "client_action_pending") return Promise.resolve(receipt);
    const flight = Promise.resolve()
      .then(async (): Promise<CommandResult> => {
        const outcome = reserved
          ? await effect().catch((error: unknown) => ({
              ok: false,
              error: actionErrorCode(error),
            }))
          : { ok: false, error: "action_outcome_uncertain" };
        return this.store.completeAsyncCommand(command.id, { commandId: command.id, ...outcome });
      })
      .finally(() => {
        this.flights.delete(command.id);
      });
    this.flights.set(command.id, { deviceId: command.deviceId, promise: flight });
    return flight;
  }
  async drained(): Promise<void> {
    await Promise.allSettled([...this.flights.values()].map((flight) => flight.promise));
  }
}

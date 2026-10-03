import { z } from "zod";
import { Command, type CommandPayload, type CommandResult } from "@ace/protocol";
import type { ServiceContext } from "../services/types.ts";
import type { DelegationService } from "../agent-control/delegations.ts";

const retryable = new Set([
  "queue_conflict",
  "engine_capacity_exceeded",
  "queue_capacity_exceeded",
]);
/** Admission receipts are immutable. Only a rejected attempt, or a switch whose
 * execution failed, may be replaced. Queued/running/accepted work retains its id. */
export function replaceAttempt(
  result: CommandResult | undefined,
  kind: CommandPayload["type"],
  execution: string | undefined,
): boolean {
  if (!result) return false;
  return result.ok
    ? kind === "thread.switch" && execution === "failed"
    : retryable.has(result.error ?? "");
}
export class DeckCommands {
  private context: ServiceContext;
  private delegations: DelegationService;
  constructor(context: ServiceContext, delegations: DelegationService) {
    this.context = context;
    this.delegations = delegations;
    context.store.atomic((db) =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS conductor_command_attempts (operation TEXT PRIMARY KEY, command TEXT NOT NULL)",
      ),
    );
  }
  async run(operation: string, payload: CommandPayload): Promise<CommandResult> {
    const { store } = this.context;
    const engine = this.context.services.engine;
    if (!engine) throw new Error("deck_engine_unavailable");
    // One durable row per effect/target, no attempt history scan on retries.
    const command = store.atomic((db) => {
      const row = db
        .prepare("SELECT command FROM conductor_command_attempts WHERE operation=?")
        .get(operation);
      const previous = row ? Command.parse(JSON.parse(z.string().parse(row.command))) : undefined;
      const receipt = previous && store.commandReceipt(previous.id, previous.deviceId);
      const replace =
        previous &&
        replaceAttempt(receipt, previous.payload.type, engine.commandExecution(previous.id));
      if (previous && !replace) return previous;
      const next = Command.parse({
        id: previous ? `deck.attempt.${this.context.id()}` : operation,
        deviceId: "ace-conductor",
        payload,
      });
      db.prepare(
        "INSERT INTO conductor_command_attempts VALUES (?,?) ON CONFLICT(operation) DO UPDATE SET command=excluded.command",
      ).run(operation, JSON.stringify(next));
      return next;
    });
    const receipt = store.commandReceipt(command.id, command.deviceId);
    if (receipt) return receipt;
    await engine.prepareCommand(command);
    return this.delegations.command(command.id, command.payload);
  }
}

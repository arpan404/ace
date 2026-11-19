import { CommandResult, DeviceId, type CommandId } from "@ace/protocol";
import type { DatabaseSync, StatementSync } from "node:sqlite";
interface ReceiptSource {
  statement(sql: string): StatementSync;
  atomic<T>(run: (db: DatabaseSync) => T): T;
  now(): number;
  /**
   * Whether two device ids are one device: the same id, or a paired record and the ace
   * account device of the same app install (ADR 0115), whose saved work moves between them.
   */
  sameDevice(a: string, b: string): boolean;
}
/** Durable command identity and guarded completion of pending receipts. */
export class CommandReceipts {
  private readonly source: ReceiptSource;
  constructor(source: ReceiptSource) {
    this.source = source;
  }
  recordCommand(commandId: CommandId, deviceId: DeviceId, run: () => CommandResult): CommandResult {
    return this.source.atomic(() => {
      const receipt = this.source
        .statement("SELECT result,device_id FROM command_receipts WHERE command_id = ?")
        .get(commandId);
      if (receipt) {
        if (!this.source.sameDevice(DeviceId.parse(receipt.device_id), deviceId))
          return { commandId, ok: false, error: "forbidden" };
        return CommandResult.parse(JSON.parse(String(receipt.result)));
      }
      const result = CommandResult.parse(run());
      if (result.commandId !== commandId) throw new Error("Command result id mismatch");
      this.source
        .statement("INSERT INTO command_receipts VALUES (?, ?, ?, ?)")
        .run(commandId, deviceId, this.source.now(), JSON.stringify(result));
      return result;
    });
  }
  commandReceipt(commandId: CommandId, deviceId: DeviceId): CommandResult | undefined {
    const row = this.source
      .statement("SELECT result,device_id FROM command_receipts WHERE command_id=?")
      .get(commandId);
    return row && this.source.sameDevice(String(row.device_id), deviceId)
      ? CommandResult.parse(JSON.parse(String(row.result)))
      : undefined;
  }
  /**
   * The device id a command's receipt is stored under, when `deviceId` is that device or the
   * same device under its other id (ADR 0115). Settling and releasing go by this owner, so a
   * retry through the other id reaches the receipt the lookup found.
   */
  commandOwner(commandId: CommandId, deviceId: DeviceId): DeviceId | undefined {
    const row = this.source
      .statement("SELECT device_id FROM command_receipts WHERE command_id=?")
      .get(commandId);
    if (!row) return undefined;
    const owner = DeviceId.parse(row.device_id);
    return this.source.sameDevice(owner, deviceId) ? owner : undefined;
  }
  completeAsyncCommand(id: CommandId, input: CommandResult): CommandResult {
    const result = CommandResult.parse(input);
    if (result.commandId !== id) throw new Error("Command result id mismatch");
    return this.source.atomic((db) => {
      db.prepare(
        "UPDATE command_receipts SET result=? WHERE command_id=? AND json_extract(result,'$.error')='client_action_pending'",
      ).run(JSON.stringify(result), id);
      const row = db.prepare("SELECT result FROM command_receipts WHERE command_id=?").get(id);
      if (!row) throw new Error("Missing command reservation");
      return CommandResult.parse(JSON.parse(String(row.result)));
    });
  }
  releaseReviewCommand(commandId: CommandId, deviceId: DeviceId): void {
    const owner = this.commandOwner(commandId, deviceId);
    if (!owner) return;
    this.source
      .statement(
        "DELETE FROM command_receipts WHERE command_id = ? AND device_id = ? AND json_extract(result, '$.error') = 'review_pending'",
      )
      .run(commandId, owner);
  }
  /**
   * Forgets a command's final refusal so the same id can run again. An accepted command, and one
   * still waiting on a review or client action, stays as it is.
   */
  releaseRefusedCommand(commandId: CommandId, deviceId: DeviceId): void {
    const owner = this.commandOwner(commandId, deviceId);
    if (!owner) return;
    this.source
      .statement(
        "DELETE FROM command_receipts WHERE command_id = ? AND device_id = ? AND json_extract(result, '$.ok') = 0 AND coalesce(json_extract(result, '$.error'), '') NOT IN ('review_pending', 'client_action_pending')",
      )
      .run(commandId, owner);
  }
  completeReviewCommand(
    commandId: CommandId,
    deviceId: DeviceId,
    input: CommandResult,
  ): CommandResult {
    const result = CommandResult.parse(input);
    if (result.commandId !== commandId) throw new Error("Command result id mismatch");
    return this.source.atomic(() => {
      const owner = this.commandOwner(commandId, deviceId);
      if (!owner) return { commandId, ok: false, error: "forbidden" };
      this.source
        .statement(
          "UPDATE command_receipts SET result = ? WHERE command_id = ? AND device_id = ? AND json_extract(result, '$.error') = 'review_pending'",
        )
        .run(JSON.stringify(result), commandId, owner);
      const row = this.source
        .statement("SELECT result FROM command_receipts WHERE command_id = ?")
        .get(commandId);
      if (!row) throw new Error("Missing review command reservation");
      return CommandResult.parse(JSON.parse(String(row.result)));
    });
  }
}

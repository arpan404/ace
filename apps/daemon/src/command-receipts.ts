import { CommandResult, DeviceId, type CommandId } from "@ace/protocol";
import type { DatabaseSync, StatementSync } from "node:sqlite";
interface ReceiptSource {
  statement(sql: string): StatementSync;
  atomic<T>(run: (db: DatabaseSync) => T): T;
  now(): number;
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
        if (DeviceId.parse(receipt.device_id) !== deviceId)
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
      .statement("SELECT result FROM command_receipts WHERE command_id=? AND device_id=?")
      .get(commandId, deviceId);
    return row ? CommandResult.parse(JSON.parse(String(row.result))) : undefined;
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
    this.source
      .statement(
        "DELETE FROM command_receipts WHERE command_id = ? AND device_id = ? AND json_extract(result, '$.error') = 'review_pending'",
      )
      .run(commandId, deviceId);
  }
  completeReviewCommand(
    commandId: CommandId,
    deviceId: DeviceId,
    input: CommandResult,
  ): CommandResult {
    const result = CommandResult.parse(input);
    if (result.commandId !== commandId) throw new Error("Command result id mismatch");
    return this.source.atomic(() => {
      this.source
        .statement(
          "UPDATE command_receipts SET result = ? WHERE command_id = ? AND device_id = ? AND json_extract(result, '$.error') = 'review_pending'",
        )
        .run(JSON.stringify(result), commandId, deviceId);
      const row = this.source
        .statement("SELECT result FROM command_receipts WHERE command_id = ?")
        .get(commandId);
      if (!row) throw new Error("Missing review command reservation");
      return CommandResult.parse(JSON.parse(String(row.result)));
    });
  }
}

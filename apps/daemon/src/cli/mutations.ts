import { CommandPayload, CommandId } from "@ace/protocol";
import { randomUUID } from "node:crypto";
import { ClientError, type Client } from "@ace/client";
import { option, type Args } from "./args.ts";
import { CliFailure } from "./output.ts";
export function key(args: Args): string {
  const value = option(args, "idempotency-key") ?? randomUUID();
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(value))
    throw new CliFailure(
      "refused",
      "Idempotency key must be 1-128 letters, digits, dots, underscores or hyphens",
    );
  return value;
}
export async function command(client: Client, payload: unknown, id: string, signal: AbortSignal) {
  const parsed = CommandPayload.parse(payload);
  try {
    const receipt = await client.command(parsed, { signal }, CommandId.parse(id));
    if (!receipt.ok)
      throw new CliFailure(
        receipt.error?.includes("uncertain") ? "uncertain" : "refused",
        receipt.error ?? receipt.code ?? "Command refused",
      );
    return { ...receipt, idempotencyKey: id };
  } catch (error) {
    if (signal.aborted || (error instanceof ClientError && error.code === "timeout"))
      throw new CliFailure(
        "uncertain",
        `Command acknowledgement unavailable; retry with --idempotency-key ${id}`,
        {
          commandId: id,
          idempotencyKey: id,
          ...("threadId" in parsed ? { threadId: parsed.threadId } : {}),
        },
      );
    throw error;
  }
}

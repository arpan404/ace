import { CommandPayload, CommandId } from "@ace/protocol";
import { randomUUID } from "node:crypto";
import { ClientError, type Client } from "@ace/client";
import { option, type Args } from "./args.ts";
import { CliFailure, usageFailure } from "./output.ts";
export function key(args: Args): string {
  const value = option(args, "idempotency-key") ?? randomUUID();
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(value))
    throw usageFailure(
      "--idempotency-key takes 1 to 128 letters, digits, dots, underscores or hyphens.",
      { argument: "--idempotency-key" },
    );
  return value;
}
export async function command(client: Client, payload: unknown, id: string, signal: AbortSignal) {
  const parsed = CommandPayload.parse(payload);
  try {
    const receipt = await client.command(parsed, { signal }, CommandId.parse(id));
    if (receipt.error === "action_busy")
      throw new CliFailure("refused", "ace is busy with other work.", undefined, {
        code: "busy",
        hint: "Retry the command shortly.",
      });
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
        "ace didn't confirm whether it ran.",
        {
          commandId: id,
          idempotencyKey: id,
          ...("threadId" in parsed ? { threadId: parsed.threadId } : {}),
        },
        { idempotencyKey: id },
      );
    throw error;
  }
}

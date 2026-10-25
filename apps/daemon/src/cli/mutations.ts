import { CommandPayload, CommandId, type CommandResult } from "@ace/protocol";
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
/** Sends of a command the daemon turned away as busy before dispatching anything. */
const busyAttempts = 8;
/** A refusal given before any effect was admitted, because the daemon is at capacity. */
const busy = (receipt: CommandResult) =>
  !receipt.ok && receipt.code === "action_not_dispatched" && receipt.error === "action_busy";
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
}
/**
 * One command, sent again while the daemon refuses it as busy. That refusal admitted nothing,
 * so each new send is safe; it goes under its own id, as the refused one is settled.
 */
async function send(client: Client, payload: CommandPayload, id: string, signal: AbortSignal) {
  let receipt = await client.command(payload, { signal }, CommandId.parse(id));
  for (let attempt = 1; attempt < busyAttempts && busy(receipt) && !signal.aborted; attempt++) {
    await pause(Math.min(2000, 100 * 2 ** attempt), signal);
    if (signal.aborted) break;
    receipt = await client.command(payload, { signal }, CommandId.parse(`${id}.${attempt}`));
  }
  if (busy(receipt))
    throw new CliFailure("refused", "ace is busy with other work; retry the command shortly");
  return receipt;
}
export async function command(client: Client, payload: unknown, id: string, signal: AbortSignal) {
  const parsed = CommandPayload.parse(payload);
  try {
    const receipt = await send(client, parsed, id, signal);
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

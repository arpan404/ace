import { preview } from "./presentation.ts";
import { CommandPayload, type CommandResult } from "@ace/protocol";
import type { ClientCore } from "@ace/client";
import type { PatchSink } from "./agents.ts";

export type Receipt = {
  ok: boolean;
  error?: string | undefined;
  /** What still runs when a delete was refused for it (`CommandResult.alive`). */
  alive?: CommandResult["alive"];
  /** What a `thread.create` or `workspace.add` made. */
  threadId?: string | undefined;
  /** The thread a `thread.fork` opened. */
  forkThreadId?: string | undefined;
  workspace?: { id: string } | undefined;
};

/**
 * Durable admission through the SDK outbox: `onSaved` once the command is saved on this device,
 * then exactly one receipt callback. Rejects when the device can't save it.
 */
export async function submitCommand(
  owner: Pick<ClientCore, "commandId" | "intent" | "enqueue">,
  payload: CommandPayload,
  onSaved: () => void,
  onReceipt: (result: Receipt) => void,
  /** A command id the caller keeps, so sending the same draft again replays it. */
  id = owner.commandId(),
): Promise<void> {
  const intent = owner.intent(id);
  let settled = false;
  let stop: (() => void) | undefined;
  const receipt = () => {
    if (settled) return;
    const result = intent.getSnapshot()?.result;
    if (!result) return;
    settled = true;
    stop?.();
    onReceipt(result);
  };
  stop = intent.subscribe(receipt);
  try {
    await owner.enqueue(payload, id);
  } catch (error) {
    stop();
    throw error;
  }
  onSaved();
  receipt();
}

/** Admission resolves at the SDK's persistence boundary; receipts stay SDK-owned. */
export async function dispatchCommand(
  owner: ClientCore,
  raw: unknown,
  requestId: string,
  pump: PatchSink,
  hooks: {
    saved?(): void;
    receipt?(result: Receipt): void;
    unsaved?(): void;
    /** Words for the daemon's refusal; its own error by default. */
    refusal?(error: string | undefined): string;
  } = {},
): Promise<void> {
  try {
    await submitCommand(
      owner,
      CommandPayload.parse(raw),
      () => {
        hooks.saved?.();
        pump.put(`admission:${requestId}`, () => ({
          type: "admission",
          id: requestId,
          ok: true,
          message: "",
        }));
      },
      (result) => {
        hooks.receipt?.(result);
        pump.put(`receipt:${requestId}`, () => ({
          type: "receipt",
          id: requestId,
          ok: result.ok,
          message: result.ok
            ? ""
            : preview(hooks.refusal?.(result.error) ?? result.error ?? "Request refused", 2048),
        }));
      },
    );
  } catch {
    hooks.unsaved?.();
    pump.put(`admission:${requestId}`, () => ({
      type: "admission",
      id: requestId,
      ok: false,
      message: "Could not save the request on this device. Your draft is still available.",
    }));
  }
}

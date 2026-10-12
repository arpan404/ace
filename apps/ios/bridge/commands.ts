import { CommandPayload } from "@ace/protocol";
import type { ClientCore } from "@ace/client";
import type { PatchPump } from "./patches.ts";

/** Admission resolves at the SDK's persistence boundary; receipts stay SDK-owned. */
export async function dispatchCommand(
  owner: ClientCore,
  raw: unknown,
  requestId: string,
  pump: PatchPump,
): Promise<void> {
  let stop: (() => void) | undefined;
  try {
    const payload = CommandPayload.parse(raw);
    const id = owner.commandId();
    const intent = owner.intent(id);
    let settled = false;
    const receipt = () => {
      if (settled) return;
      const result = intent.getSnapshot()?.result;
      if (!result) return;
      settled = true;
      stop?.();
      pump.put(`receipt:${requestId}`, () => ({
        type: "receipt",
        id: requestId,
        ok: result.ok,
        message: result.ok ? "" : (result.error ?? "Request refused"),
      }));
    };
    stop = intent.subscribe(receipt);
    await owner.enqueue(payload, id);
    pump.put(`admission:${requestId}`, () => ({
      type: "admission",
      id: requestId,
      ok: true,
      message: "",
    }));
    receipt();
  } catch {
    stop?.();
    pump.put(`admission:${requestId}`, () => ({
      type: "admission",
      id: requestId,
      ok: false,
      message: "Could not save the request on this device. Your draft is still available.",
    }));
  }
}

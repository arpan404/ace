import type { ClientCore } from "@ace/client";
import { tokensFromInput } from "@ace/ui-core";
import type { PatchSink } from "./agents.ts";
import type { DismissedSends } from "./dismissed-sends.ts";

/**
 * Discard, Undo and Edit of a failed send. Each answers only after the choice is saved on the
 * phone: a save that fails keeps the row and says so. Edit hands back the send's full words.
 */
export async function settleSend(
  owner: ClientCore,
  action: { kind: "dismissSend" | "restoreSend" | "takeBackSend"; commandId: string },
  requestId: string,
  pump: PatchSink,
  kept: DismissedSends | undefined,
): Promise<void> {
  const send = owner.pendingSend(action.commandId);
  // Only a send still failed can be dealt with: one on its way is never hidden.
  const failed = action.kind === "restoreSend" || send?.state === "failed";
  const saved =
    !!kept &&
    failed &&
    (action.kind === "restoreSend"
      ? await kept.restore(action.commandId)
      : await kept.dismiss(action.commandId));
  const message = !failed
    ? "That message isn't waiting any more."
    : saved
      ? ""
      : "Couldn't save that on this phone. The message is still here.";
  if (action.kind === "takeBackSend") {
    const text = saved && send ? tokensFromInput(send.payload.input).text : null;
    pump.put(`words:${requestId}`, () => ({
      type: "words",
      id: requestId,
      ok: saved,
      text,
      message,
    }));
    return;
  }
  pump.put(`admission:${requestId}`, () => ({
    type: "admission",
    id: requestId,
    ok: saved,
    message,
  }));
}

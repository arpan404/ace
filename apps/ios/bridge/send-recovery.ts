import type { ClientCore } from "@ace/client";
import { tokensFromInput } from "@ace/ui-core";
import type { PatchSink } from "./agents.ts";
import type { DismissedSends } from "./dismissed-sends.ts";
import type { TakeBackLedger } from "./take-back-ledger.ts";

/**
 * Discard, Undo and Edit of a failed send. Each answers only after the choice is saved on the
 * phone: a save that fails keeps the row and says so. Edit hands back the send's full words,
 * kept in a take-back record first (`take-back-ledger.ts`) until the phone has them in its draft.
 */
export async function settleSend(
  owner: ClientCore,
  action: { kind: "dismissSend" | "restoreSend" | "takeBackSend"; commandId: string },
  requestId: string,
  pump: PatchSink,
  kept: DismissedSends | undefined,
  ledger: TakeBackLedger,
): Promise<void> {
  const send = owner.pendingSend(action.commandId);
  // Only a send still failed can be dealt with: one on its way is never hidden.
  const failed = action.kind === "restoreSend" || send?.state === "failed";
  const text = send ? tokensFromInput(send.payload.input).text : "";
  const record = owner.commandId();
  const recorded =
    action.kind !== "takeBackSend" ||
    (failed &&
      !!send &&
      (await ledger.record({
        id: record,
        threadId: send.threadId,
        text,
        kind: "send",
        source: action.commandId,
      })));
  const saved =
    !!kept &&
    failed &&
    recorded &&
    (action.kind === "restoreSend"
      ? await kept.restore(action.commandId)
      : await kept.dismiss(action.commandId));
  if (action.kind === "takeBackSend" && !saved) await ledger.settle(record);
  const message = !failed
    ? "That message isn't waiting any more."
    : saved
      ? ""
      : "Couldn't save that on this phone. The message is still here.";
  if (action.kind === "takeBackSend") {
    pump.put(`words:${requestId}`, () => ({
      type: "words",
      id: requestId,
      ok: saved,
      text: saved ? text : null,
      message,
      ...(saved ? { record } : {}),
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

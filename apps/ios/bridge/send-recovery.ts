import type { ClientCore } from "@ace/client";
import { inputWithText, tokensFromInput } from "@ace/ui-core";
import type { PatchSink } from "./agents.ts";
import type { DismissedSends } from "./dismissed-sends.ts";
import { retryOf, sendBusy, type SendOps } from "./send-ops.ts";

/*
 * What the person does with a send that failed on the phone. Discard and Undo answer only once the
 * choice is saved: a save that fails keeps the row and says so. Edit reads the send's full words
 * (`sendWords`) and saves new ones in place in the outbox (`editSend`, one write: the original
 * stays until the edit is saved); Retry then sends the edited message. An edit never runs beside a
 * retry of the same send (`send-ops.ts`), and a send already sent again is acted on through its
 * newer attempt.
 */

export type SendAction =
  | { kind: "dismissSend" | "restoreSend" | "sendWords"; commandId: string }
  | { kind: "editSend"; commandId: string; text: string };

const gone = "That message isn't waiting any more.";

export async function settleSend(
  owner: ClientCore,
  action: SendAction,
  requestId: string,
  pump: PatchSink,
  kept: DismissedSends | undefined,
  ops: SendOps,
): Promise<void> {
  const send = owner.pendingSend(action.commandId);
  // A send already sent again stands aside for its newer attempt.
  const failed = send?.state === "failed" && !owner.pendingSend(retryOf(action.commandId));
  const admit = (ok: boolean, message: string) =>
    pump.put(`admission:${requestId}`, () => ({ type: "admission", id: requestId, ok, message }));
  // The edit sheet waits on one answer that carries why not.
  const answer = (ok: boolean, message: string) =>
    pump.put(`words:${requestId}`, () => ({
      type: "words",
      id: requestId,
      ok,
      text: null,
      message,
    }));
  switch (action.kind) {
    case "sendWords": {
      const text = failed && send ? tokensFromInput(send.payload.input).text : null;
      pump.put(`words:${requestId}`, () => ({
        type: "words",
        id: requestId,
        ok: text !== null,
        text,
        message: text === null ? gone : "",
      }));
      return;
    }
    case "editSend": {
      const text = action.text.trim();
      if (!failed || !send) return answer(false, gone);
      if (!text) return answer(false, "Write a message first.");
      try {
        const ran = await ops.run(action.commandId, "editing", () =>
          owner.editFailedSend(action.commandId, {
            ...send.payload,
            input: inputWithText(send.payload.input, text),
          }),
        );
        answer(ran.ran, ran.ran ? "" : sendBusy(ran.running));
      } catch {
        answer(false, "Couldn't save the edit on this phone. The original is still here.");
      }
      return;
    }
    default: {
      // Only a send still failed can be dealt with: one on its way is never hidden.
      const allowed = action.kind === "restoreSend" || failed;
      const saved =
        !!kept &&
        allowed &&
        (action.kind === "restoreSend"
          ? await kept.restore(action.commandId)
          : await kept.dismiss(action.commandId));
      admit(
        saved,
        !allowed
          ? gone
          : saved
            ? ""
            : "Couldn't save that on this phone. The message is still here.",
      );
    }
  }
}

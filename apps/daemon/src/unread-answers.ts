import type { Command, CommandResult } from "@ace/protocol";
import { answerRefusal } from "@ace/projection/interaction-summary";
import type { Store } from "./store.ts";

/**
 * A client's yes to a request clients get summarized goes only when the person was shown it
 * whole as it is now (ADR 0157): `readWhole` must be the version the request reads under. An
 * answer that names a version is held to it whatever the request's size, so one replaced by a
 * smaller request since is refused too. Run in the same synchronous step that applies the
 * answer, so a request replaced while the command waited on its lane is checked as it is when
 * the answer would land.
 */
export function unreadAnswer(
  command: Command,
  store: Pick<Store, "getInteraction" | "interactionRequestVersion">,
): CommandResult | undefined {
  const payload = command.payload;
  if (payload.type !== "interaction.resolve") return undefined;
  const asked = store.getInteraction(payload.interactionId);
  if (!asked) return undefined;
  const named = payload.readWhole;
  const shown =
    named !== undefined && named === store.interactionRequestVersion(asked.threadId, asked.id);
  const refusal =
    named !== undefined && !shown
      ? "request_not_read"
      : answerRefusal(asked, payload.resolution, shown);
  return refusal && { commandId: command.id, ok: false, error: refusal };
}

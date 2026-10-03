import { CommandPayload } from "@ace/protocol";
import type { Alert, NotificationAction } from "./router.ts";

/**
 * The daemon command for a notification action. Ids are derived from the alert and action,
 * so a double click or a retried delivery is one command; the daemon's first-answer-wins
 * resolution settles races with other devices.
 */
export function actionCommand(
  alert: Alert,
  action: NotificationAction,
  reply?: string,
): { id: string; payload: CommandPayload } | undefined {
  const id = `notification-${alert.id}-${action}`.slice(0, 200);
  const option = (wanted: "approve" | "deny") =>
    alert.actions?.find((entry) => entry.action === wanted)?.optionId;
  if (action !== "reply") {
    const optionId = option(action);
    if (!alert.interactionId || !optionId) return undefined;
    return {
      id,
      payload: CommandPayload.parse({
        type: "interaction.resolve",
        interactionId: alert.interactionId,
        resolution: { kind: "approval", optionId },
      }),
    };
  }
  const text = reply?.trim();
  if (!text || !alert.threadId) return undefined;
  const deny = option("deny");
  // Replying to a pending approval declines it with the person's message as the reason.
  if (alert.interactionId && deny)
    return {
      id,
      payload: CommandPayload.parse({
        type: "interaction.resolve",
        interactionId: alert.interactionId,
        resolution: { kind: "approval", optionId: deny, message: text },
      }),
    };
  return {
    id,
    payload: CommandPayload.parse({
      type: "thread.send",
      threadId: alert.threadId,
      input: [{ type: "text", text }],
      delivery: "queue",
    }),
  };
}

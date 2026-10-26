import { z } from "zod";

/**
 * Windows keeps ace's toasts in the notification centre after their objects are gone, and after
 * a restart. Electron reports every activation of one (`Notification.handleActivation`), in
 * addition to the live toast's own events when it still has one.
 *
 * The OS's details are parsed strictly; nothing in them is acted on beyond their kind. A toast
 * whose live object already answered (it ran the button, the reply or opened its thread) needs
 * nothing more. Otherwise ace comes forward: a button or reply on a stale toast can no longer
 * reach its request, so the person sees the request still waiting instead of nothing at all.
 */
export const ToastActivation = z.object({
  type: z.enum(["click", "action", "reply"]),
  arguments: z.string().max(4096),
  actionIndex: z.number().int().min(0).max(16).optional(),
  reply: z.string().max(10_000).optional(),
});
export type ToastActivation = z.infer<typeof ToastActivation>;

/** How long after an activation a live toast's own event may still arrive. */
export const liveToastGraceMs = 250;

export type ActivationOutcome = "open" | "handled" | "ignored";

/** `handledByLiveToast`: a live toast ran its own click, button or reply in the grace window. */
export function toastActivationOutcome(
  details: unknown,
  handledByLiveToast: boolean,
): ActivationOutcome {
  const parsed = ToastActivation.safeParse(details);
  if (!parsed.success) return "ignored";
  return handledByLiveToast ? "handled" : "open";
}

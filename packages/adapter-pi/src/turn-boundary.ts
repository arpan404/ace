import { z } from "zod";
import type { PiExtensionApi } from "./extension-api.ts";

const Boundary = z.object({
  type: z.literal("ace_turn_boundary"),
  entryId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[-a-zA-Z0-9_]+$/),
});

/** Pi has persisted the assistant message and tool results before turn_end handlers run. */
export function registerPiTurnBoundaries(pi: PiExtensionApi): void {
  pi.on("turn_end", (_event, ctx) => {
    const boundary = Boundary.safeParse({
      type: "ace_turn_boundary",
      entryId: ctx.sessionManager?.getLeafId(),
    });
    if (boundary.success) ctx.ui.notify(JSON.stringify(boundary.data), "info");
  });
}

export function piTurnBoundary(message: unknown): string | undefined {
  if (typeof message !== "string" || message.length > 512) return;
  try {
    const boundary = Boundary.safeParse(JSON.parse(message));
    return boundary.success ? boundary.data.entryId : undefined;
  } catch {
    return;
  }
}

import type { BrowserCommand } from "@ace/protocol";
import { BrowserActionError } from "./action-error.ts";
import type { AnnotationSession } from "./annotation-session.ts";
import type { BrowserCdp } from "./backend.ts";
import type { Actor } from "./session-options.ts";

type AnnotationCommand = Extract<BrowserCommand, { action: "annotate" | "annotate_capture" }>;

/**
 * Annotate mode is the person's: the session has already checked that this actor holds the
 * control lease. Agents never start, drive or capture it.
 */
export async function executeAnnotation(
  command: AnnotationCommand,
  actor: Actor,
  cdp: BrowserCdp,
  annotation: AnnotationSession,
): Promise<unknown> {
  if (actor.kind !== "human") throw new BrowserActionError("lease_required");
  if (command.action === "annotate_capture")
    return annotation.capture(actor.connectionId, command.target);
  switch (command.operation) {
    case "start":
      return annotation.start(cdp, actor.connectionId, command.config);
    case "stop":
      annotation.stop(actor.connectionId);
      return { ok: true };
    case "command":
      return annotation.command(actor.connectionId, command.command);
  }
}

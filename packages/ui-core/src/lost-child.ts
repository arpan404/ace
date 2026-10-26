import { z } from "zod";
import type { Interaction } from "@ace/protocol";

const About = z.object({ threadId: z.string() });

/**
 * The child on another machine a pending request is about, when it is the daemon's request
 * about a child whose pairing is gone (ADR 0099): answering it stops tracking that child.
 */
export function lostChildOf(interaction: Interaction): string | undefined {
  if (interaction.state !== "pending" || interaction.request.kind !== "approval") return undefined;
  for (const entry of interaction.raw) {
    if (entry.type !== "ace.machine.lost" || !("data" in entry)) continue;
    const about = About.safeParse(entry.data);
    if (about.success) return about.data.threadId;
  }
  return undefined;
}

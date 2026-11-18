import type { TransferLive } from "@ace/protocol";

/*
 * What the agent is told when its thread moves (ADR 0191). Pure. One plain paragraph each.
 */

const list = (items: readonly string[]) => items.slice(0, 8).join(", ");

/** The target's first turn: it moved, where the project is, and what stayed behind. */
export function continueMessage(input: {
  from: string;
  path: string;
  live: Pick<TransferLive, "left">;
  session: { kind: "native" | "summary"; reason?: string | undefined };
}): string {
  const { left } = input.live;
  const lines = [
    `This thread moved here from ${input.from} while you were working. Carry on where you left off. The project is now at ${input.path}.`,
    input.session.kind === "native"
      ? "Your full conversation came with it."
      : `Your conversation came as the summary above${input.session.reason ? ` (${input.session.reason})` : ""}.`,
  ];
  if (left.shells.length)
    lines.push(`Stopped on ${input.from}, start again if you need them: ${list(left.shells)}.`);
  if (left.children.length)
    lines.push(`Subagent threads stopped on ${input.from}: ${list(left.children)}.`);
  if (left.remoteChildren.length)
    lines.push(
      `Still running on other machines, reporting to the thread on ${input.from}: ${list(left.remoteChildren)}.`,
    );
  if (left.queued)
    lines.push(
      `${left.queued} queued message${left.queued === 1 ? "" : "s"} stayed on ${input.from}.`,
    );
  lines.push("Files Git ignores are as they were when the move began.");
  return lines.join(" ");
}

/** The source's turn when the move didn't happen, so the agent carries on here. */
export function resumeMessage(machine: string, reason: string): string {
  return `Moving this thread to ${machine} didn't work: ${reason} Carry on where you left off, here.`;
}

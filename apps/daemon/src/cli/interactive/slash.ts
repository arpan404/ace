import {
  InteractionId,
  InteractionResolution,
  ProviderKind,
  ThreadId,
  type CommandPayload,
} from "@ace/protocol";
import { approval } from "../approval.ts";
import { chatAction } from "../chat-input.ts";
import type { OpenRequest } from "./request-answer.ts";

/**
 * Attach's slash commands (ADR 0176 §9), with the meaning `ace chat` gave them: `/steer TEXT`,
 * `/stop`, `/model MODEL`, `/resume [THREAD]`, `/approve` and `/deny`, `/help`, `/quit`. The
 * syntax is `chat-input.ts`'s; this turns each into the daemon command it stands for.
 */
export interface SlashPorts {
  readonly threadId: string | undefined;
  readonly provider: string | undefined;
  readonly pending: readonly OpenRequest[];
  flash(text: string): void;
  submit(payload: CommandPayload, done: string): Promise<void>;
  send(text: string, delivery: "queue" | "steer"): Promise<void>;
  quit(): void;
  /** `/model` before the thread exists: the model the first prompt starts it with. */
  chooseModel(model: string): void;
  queue(threadId: ThreadId): Promise<{ paused: boolean; revision: number }>;
}

const help =
  "/steer TEXT redirects · /stop stops the tree · /model MODEL · /resume · /approve · /deny · /quit · // sends a slash";

export async function slashCommand(line: string, ports: SlashPorts): Promise<void> {
  let action;
  try {
    action = chatAction(line);
  } catch (error) {
    return ports.flash(error instanceof Error ? error.message : "Unknown command. Type /help.");
  }
  const id = ports.threadId;
  switch (action.kind) {
    case "empty":
      return;
    case "quit":
      return ports.quit();
    case "help":
      return ports.flash(help);
    case "send":
    case "steer":
      return ports.send(action.text, action.kind === "steer" ? "steer" : "queue");
    case "model":
      if (!id) {
        ports.chooseModel(action.model);
        return ports.flash(`The new thread will use ${action.model}.`);
      }
      return ports.submit(
        {
          type: "thread.switch",
          threadId: ThreadId.parse(id),
          selection: { provider: ProviderKind.parse(ports.provider), model: action.model },
        },
        `Switched to ${action.model}.`,
      );
  }
  if (!id) return ports.flash("Send a prompt to start the thread first.");
  if (action.kind === "stop")
    return ports.submit(
      { type: "thread.interrupt", threadId: ThreadId.parse(id), cascade: true },
      "Stopping the tree.",
    );
  if (action.kind === "resume") {
    const target = ThreadId.parse(action.thread ?? id);
    try {
      const queue = await ports.queue(target);
      return ports.submit(
        {
          type: queue.paused ? "queue.resume" : "thread.resume",
          threadId: target,
          expectedRevision: queue.revision,
        },
        "Resumed.",
      );
    } catch (error) {
      return ports.flash(error instanceof Error ? error.message : "Resume didn't go through.");
    }
  }
  if (action.kind !== "approve" && action.kind !== "deny") return;
  const chosen = action.interaction
    ? ports.pending.find((open) => open.interaction.id === action.interaction)
    : ports.pending.length === 1
      ? ports.pending[0]
      : undefined;
  if (!chosen) return ports.flash("Say which request: /approve REQUEST.");
  try {
    const resolution = approval(chosen.interaction, action.kind, action.option);
    return ports.submit(
      {
        type: "interaction.resolve",
        interactionId: InteractionId.parse(chosen.interaction.id),
        resolution: InteractionResolution.parse(resolution),
      },
      action.kind === "approve" ? "Allowed." : "Denied.",
    );
  } catch (error) {
    return ports.flash(error instanceof Error ? error.message : "That answer didn't go through.");
  }
}

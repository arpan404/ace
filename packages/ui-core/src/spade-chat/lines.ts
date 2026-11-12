import type { SpadeAgent } from "./agents.ts";
import type { SpadeEndpoint } from "./endpoints.ts";
import { spadeCappedLine } from "./oversight.ts";

/*
 * The few words every client shows beside a bot and an approval, and an endpoint's key row. A
 * key is never shown; clients see only whether one is set and where it comes from (ADR 0119).
 */

/** A roster row's second line, and its state's colour when it has one. */
export interface SpadeAgentLine {
  text: string;
  tone?: "working" | "needs-you";
}

/** What a bot does now, a cap it is at, else its latest message. */
export function spadeAgentLine(
  agent: Pick<
    SpadeAgent,
    "state" | "waitingFor" | "status" | "problem" | "spending" | "lastMessage"
  >,
): SpadeAgentLine {
  if (agent.state === "waiting" && agent.waitingFor === "question")
    return { text: "Asked you a question", tone: "needs-you" };
  if (agent.state === "waiting")
    return { text: agent.status ?? "Waiting for you", tone: "needs-you" };
  if (agent.state === "working") return { text: agent.status ?? "Working", tone: "working" };
  // A subscription that couldn't run (signed out, out of quota) until a later reply works.
  if (agent.problem) return { text: agent.problem, tone: "needs-you" };
  // At a cap it makes no model call until the cap ends (ADR 0135).
  if (agent.spending?.capped) return { text: spadeCappedLine(agent.spending.capped) };
  const last = agent.lastMessage;
  if (!last?.text) return { text: "No messages yet" };
  if (last.from === "agent") return { text: last.text };
  return { text: `${last.fromAgent ? last.fromAgent.name : "You"}: ${last.text}` };
}

/**
 * The exact command a shell call would run, which "always" covers (that command, nothing like
 * it); undefined for every other tool.
 */
export function spadeShellCommand(name: string, args: unknown): string | undefined {
  if (name !== "shell" || typeof args !== "object" || args === null) return undefined;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

/** Most of a call's arguments an approval shows; the rest is cut with an ellipsis. */
const maxDetailChars = 20_000;

/**
 * What an approval would do, as text: its arguments as the bot sent them, indented JSON.
 * Undefined when the call carries none.
 */
export function spadeCallDetails(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
  } catch {
    return undefined;
  }
  if (!text || text === "{}") return undefined;
  return text.length > maxDetailChars ? `${text.slice(0, maxDetailChars)}…` : text;
}

/** What an endpoint's Key row says and offers. */
export interface SpadeKeyLine {
  description: string;
  /** A key can be typed here and saved to the machine's keychain. */
  canSave: boolean;
  /** Only a key in the keychain can be removed from here; the environment's stays. */
  canRemove: boolean;
  placeholder: string;
}

export function spadeKeyLine(endpoint: SpadeEndpoint, keychain: boolean): SpadeKeyLine {
  if (!keychain)
    return {
      description:
        endpoint.keySource === "environment"
          ? "Set from the environment."
          : "This machine has no keychain. Set the endpoint's environment variable for Spade.",
      canSave: false,
      canRemove: false,
      placeholder: "",
    };
  return {
    description:
      endpoint.keySource === "environment"
        ? "Set from the environment. A key saved here is used instead."
        : endpoint.keySet === undefined
          ? "Checking the keychain…"
          : endpoint.keySet
            ? "Set"
            : "Not set. Spade can't use these models without it.",
    canSave: true,
    canRemove: endpoint.keySource === "keychain",
    placeholder: endpoint.keySet === false ? "Paste key" : "Replace key",
  };
}

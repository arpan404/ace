import type { Command, CommandResult, Interaction } from "@ace/protocol";
import { reauthSentence } from "./marketplace/fresh-sign-in.ts";

/*
 * Who may answer a request (AGENTS.md: agents never answer approvals; ADR 0178 §12.5). Pure.
 *
 * - An agent's own device (`ace-agent`, the reviewer's `ace-reviewer`) never answers an
 *   approval, a plan, an elicitation or a browser-help request. It may answer a question its own
 *   child asked, which is how `question_answer` works.
 * - The host token is readable by any process of the person's. So a person-only market request
 *   is answered only from a socket that proved the person's standing (ADR 0190): the ace app
 *   signed in as the person, a device paired from a link the person made.
 */

const agentDevices: ReadonlySet<string> = new Set(["ace-agent", "ace-reviewer"]);

/** An agent's own device: the CLI in an agent's shell, ace's agent tools, the reviewer. */
export function isAgentDevice(device: string | undefined): boolean {
  return device !== undefined && agentDevices.has(device);
}

export function agentAnswerRefusal(
  command: Command,
  kindOf: (interactionId: string) => Interaction["request"]["kind"] | undefined,
): CommandResult | undefined {
  const payload = command.payload;
  if (payload.type !== "interaction.resolve" || !agentDevices.has(command.deviceId)) return;
  const kind = kindOf(payload.interactionId);
  if (kind === "question" && payload.resolution.kind === "question") return;
  return { commandId: command.id, ok: false, error: "human_answer_required" };
}

export interface HostAnswerFacts {
  /**
   * The socket's credential isn't the person's: the host token, or an account device whose
   * standing grant didn't say person (ADR 0190).
   */
  readonly unproven: boolean;
  /** The interaction is an open person-only market request (`market_person_pending`). */
  personOnlyMarket(interactionId: string): boolean;
}

export async function hostAnswerRefusal(
  command: Command,
  facts: HostAnswerFacts,
): Promise<{ code: "reauth"; message: string } | undefined> {
  const payload = command.payload;
  if (payload.type !== "interaction.resolve" || !facts.unproven) return undefined;
  // An agent's own device is refused outright where the request is answered.
  if (isAgentDevice(command.deviceId)) return undefined;
  if (!facts.personOnlyMarket(payload.interactionId)) return undefined;
  return { code: "reauth", message: reauthSentence };
}

/** Settings an agent could use to loosen what the person is asked. */
const guardedSettings: ReadonlySet<string> = new Set(["market.askBeforeAgentPublish"]);

/** Whether changing `key` needs a socket with the person's standing (ADR 0190). */
export function guardedSetting(key: string): boolean {
  return guardedSettings.has(key);
}

/**
 * Why a settings write is refused, or undefined when it may run. An agent's device never
 * changes the person's settings; "Ask me before agents publish" changes only from a socket that
 * proved the person's standing, as the market's person-only actions do (ADR 0190).
 */
export async function settingWriteRefusal(
  key: string,
  facts: {
    readonly device: string | undefined;
    readonly unproven: boolean;
  },
): Promise<{ code: "validation"; message: string } | undefined> {
  if (isAgentDevice(facts.device))
    return { code: "validation", message: "Settings are the person's; agents don't change them." };
  if (!guardedSettings.has(key) || !facts.unproven) return undefined;
  return { code: "validation", message: reauthSentence };
}

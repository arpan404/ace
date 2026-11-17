import type { Command, CommandResult, Interaction } from "@ace/protocol";
import { reauthSentence } from "./marketplace/fresh-sign-in.ts";

/*
 * Who may answer a request (AGENTS.md: agents never answer approvals; ADR 0176 §12.5). Pure.
 *
 * - An agent's own device (`ace-agent`, the reviewer's `ace-reviewer`) never answers an
 *   approval, a plan, an elicitation or a browser-help request. It may answer a question its own
 *   child asked, which is how `question_answer` works.
 * - The host token is the person's whole authority, and any process that reads it has it. So a
 *   person-only market request answered over the host token needs a fresh ace sign-in; the app
 *   and paired devices answer it as they are.
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
  /** The socket authenticated with the daemon's token file, not as the app or a device. */
  readonly hostCredential: boolean;
  /** The interaction is an open person-only market request (`market_person_pending`). */
  personOnlyMarket(interactionId: string): boolean;
  /** This machine's ace account signed in within the last ten minutes. */
  fresh(): Promise<boolean>;
}

export async function hostAnswerRefusal(
  command: Command,
  facts: HostAnswerFacts,
): Promise<{ code: "reauth"; message: string } | undefined> {
  const payload = command.payload;
  if (payload.type !== "interaction.resolve" || !facts.hostCredential) return undefined;
  // An agent's own device is refused outright where the request is answered.
  if (isAgentDevice(command.deviceId)) return undefined;
  if (!facts.personOnlyMarket(payload.interactionId)) return undefined;
  if (await facts.fresh()) return undefined;
  return { code: "reauth", message: reauthSentence };
}

/** Settings an agent could use to loosen what the person is asked. */
const guardedSettings: ReadonlySet<string> = new Set(["market.askBeforeAgentPublish"]);

/**
 * Why a settings write is refused, or undefined when it may run. An agent's device never
 * changes the person's settings; "Ask me before agents publish" over the host token needs a
 * fresh ace sign-in, as the market's person-only actions do; the app and paired devices change
 * it as they are.
 */
export async function settingWriteRefusal(
  key: string,
  facts: {
    readonly device: string | undefined;
    readonly hostCredential: boolean;
    fresh(): Promise<boolean>;
  },
): Promise<{ code: "validation"; message: string } | undefined> {
  if (isAgentDevice(facts.device))
    return { code: "validation", message: "Settings are the person's; agents don't change them." };
  if (!guardedSettings.has(key) || !facts.hostCredential) return undefined;
  if (await facts.fresh()) return undefined;
  return { code: "validation", message: reauthSentence };
}

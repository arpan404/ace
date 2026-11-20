import { envOn } from "./input-mode.ts";
import { CliFailure } from "./output.ts";

/*
 * What the CLI keeps for the person (ADR 0178 §10, §12.5). The host token is the person's whole
 * authority and an agent's shell can read it, so these checks guard honest agents only; the
 * daemon's own rules (agent devices never answer, person-only work only from a proven socket)
 * and the app and paired devices are what an agent can't get round. Pure.
 */

/** What a person-only command is: answering a request, or changing a setting. */
export type PersonOnly = "answer" | "setting" | "market" | "install";

/** An agent's shell: ace starts every agent session with ACE_THREAD_ID and ACE_NO_INPUT=1. */
export function agentShell(env: Readonly<Record<string, string | undefined>>): boolean {
  return (env.ACE_THREAD_ID ?? "").trim() !== "" || envOn(env.ACE_NO_INPUT);
}

/**
 * The device this CLI says it is to the local daemon: in an agent's shell `ace-agent`, so the
 * daemon's own agent rules apply (agents never answer requests or change settings), with its
 * own outbox beside the person's.
 */
export function localDevice(agent: boolean): { id: "ace-agent" | "ace-cli"; outbox: string } {
  return agent ? { id: "ace-agent", outbox: "cli-agent" } : { id: "ace-cli", outbox: "" };
}

/**
 * The market commands an agent may run itself, as the daemon's allowlist has it
 * (`marketplace/agent-gate.ts`): reads, local checks, drafts and publishing, status, versions.
 * Any other market command is the person's. With ACE_THREAD_ID the daemon turns it into a
 * request in that thread; without a thread to ask in, the CLI refuses it here.
 */
const agentMarketCommands: ReadonlySet<string> = new Set([
  "market.discover",
  "market.search",
  "market.show",
  "market.installed",
  "market.check",
  "market.publish",
  "market.draft.list",
  "market.draft.show",
  "market.draft.update",
  "market.draft.publish",
  "market.draft.delete",
  "market.status",
  "market.versions",
  "market.signals",
  "market.profile.show",
  "market.verification.show",
  "market.source.list",
  "market.source.refresh",
]);

/** A market command that is the person's (the hidden maintainer tools aside). */
export function marketPersonOnly(commandId: string): boolean {
  return (
    commandId.startsWith("market.") &&
    !commandId.startsWith("market.maintainer.") &&
    !agentMarketCommands.has(commandId)
  );
}

const what: Record<PersonOnly, string> = {
  answer: "Answering a request",
  setting: "Changing a setting",
  market: "This market action",
  install: "Installing a bot",
};

/** Why `kind` can't run here, or undefined when it may. `--yes` never changes the answer. */
export function personOnlyRefusal(
  kind: PersonOnly,
  at: { readonly agent: boolean; readonly interactive: boolean },
): CliFailure | undefined {
  if (at.agent)
    return new CliFailure(
      "needs-human",
      `${what[kind]} is yours to do, not an agent's.`,
      undefined,
      {
        code: "person_only",
        hint: "Agents never answer requests or change settings. Ask the person: they do it in the app, on a paired device or in their own terminal.",
      },
    );
  if (kind === "answer" && !at.interactive)
    return new CliFailure(
      "needs-human",
      "Answering a request needs you at a terminal to confirm it.",
      undefined,
      {
        code: "confirm",
        hint: "Run it in your own terminal without --json, --quiet or --no-input, or answer in the app or on a paired device.",
      },
    );
  return undefined;
}

/** Whether what was typed confirms: the word itself, any case, nothing else (not just Enter). */
export function typedConfirms(word: string, typed: string | undefined): boolean {
  return (typed ?? "").trim().toLowerCase() === word;
}

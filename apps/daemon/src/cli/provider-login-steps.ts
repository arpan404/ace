import type { ProviderLoginInput, ProviderLoginProgress } from "@ace/protocol";

/**
 * What `ace provider login` does next at each state of a provider's own sign-in. Pure: the
 * loop in `providers.ts` polls, prints and sends; this decides.
 */
export type LoginStep =
  | { readonly kind: "done" }
  | { readonly kind: "wait" }
  | { readonly kind: "send"; readonly input: ProviderLoginInput }
  | { readonly kind: "choose"; readonly choices: readonly { id: string; label: string }[] }
  | {
      readonly kind: "stop";
      readonly outcome: "needs-human" | "failed";
      readonly message: string;
      readonly hint?: string;
    };

export interface LoginAnswers {
  /** `--choice`, when given. */
  readonly choice?: string | undefined;
  /** A person at a terminal can pick a choice. */
  readonly interactive: boolean;
}

export function loginStep(
  progress: ProviderLoginProgress,
  answers: LoginAnswers,
  name: string,
): LoginStep {
  switch (progress.state) {
    case "succeeded":
      return { kind: "done" };
    case "starting":
    case "awaiting_browser":
    case "verifying":
    // The browser on this machine returns the code to the CLI itself; keep waiting for it.
    case "awaiting_code_entry":
      return { kind: "wait" };
    case "failed":
    case "cancelled":
      return {
        kind: "stop",
        outcome: "failed",
        message: `${name} sign-in ${progress.state === "failed" ? "failed" : "was cancelled"}${progress.message ? `: ${trimStop(progress.message)}` : ""}.`,
        hint: progress.hint ?? `Try again with ace provider login ${progress.provider}.`,
      };
    case "awaiting_api_key":
      return {
        kind: "stop",
        outcome: "needs-human",
        message: `${name} signs in with an API key here.`,
        hint: "Add the key in the app: Settings, Providers.",
      };
    case "awaiting_input": {
      const choices = progress.choices ?? [];
      if (!choices.length)
        return {
          kind: "stop",
          outcome: "needs-human",
          message: `${name} is asking something only its own terminal can answer${progress.prompt ? `: ${trimStop(progress.prompt)}` : ""}.`,
          ...(progress.manual ? { hint: `Run ${progress.manual.command} yourself.` } : {}),
        };
      if (answers.choice !== undefined) {
        const picked = choices.find((choice) => choice.id === answers.choice);
        if (picked) return { kind: "send", input: { choice: picked.id } };
        return {
          kind: "stop",
          outcome: "needs-human",
          message: `${name} has no service ${answers.choice}.`,
          hint: choiceHint(choices),
        };
      }
      if (answers.interactive) return { kind: "choose", choices };
      return {
        kind: "stop",
        outcome: "needs-human",
        message: `${name} asks which service to connect.`,
        hint: choiceHint(choices),
      };
    }
  }
}

function choiceHint(choices: readonly { id: string }[]): string {
  const shown = choices.slice(0, 6).map((choice) => choice.id);
  const more = choices.length > shown.length ? `, and ${choices.length - shown.length} more` : "";
  return `Pass --choice ID: ${shown.join(", ")}${more}.`;
}

function trimStop(text: string): string {
  return text.trim().replace(/[.!?]+$/, "");
}

/** The address and code to print, when they're new since the last poll. */
export function loginPrompt(progress: ProviderLoginProgress, name: string): string[] {
  const lines: string[] = [];
  if (progress.url) lines.push(`Open this address to sign in to ${name}:`, progress.url);
  if (progress.userCode) lines.push(`Enter the code ${progress.userCode}`);
  return lines;
}

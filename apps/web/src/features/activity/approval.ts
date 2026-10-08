import type { ApprovalOption, PermissionMode } from "@ace/protocol";
import { offeredOptions } from "@ace/ui-core";

/** The buttons an approval card shows, picked from whatever options the provider offered. */
export interface ApprovalChoices {
  approve: ApprovalOption | undefined;
  /** Wider grant offered as the "Always allow …" checkbox; replaces `approve` when ticked. */
  always: ApprovalOption | undefined;
  deny: ApprovalOption | undefined;
}

const first = (options: readonly ApprovalOption[], kinds: readonly ApprovalOption["kind"][]) => {
  for (const kind of kinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) return option;
  }
  return undefined;
};

export function approvalChoices(options: readonly ApprovalOption[]): ApprovalChoices {
  const approve = first(options, ["allow_once", "allow_session", "allow_always"]);
  const wider = first(options, ["allow_always", "allow_session"]);
  return {
    approve,
    always: wider && wider !== approve ? wider : undefined,
    deny: first(options, ["deny", "cancel", "deny_always"]),
  };
}

/**
 * The choices a card offers in the thread's effective mode (IR-13): outside full access the
 * daemon refuses "for this session" and "always" grants, so they are not offered; `hidden`
 * says some were left out, for the one-shot note.
 */
export function offeredChoices(
  options: readonly ApprovalOption[],
  mode: PermissionMode | null | undefined,
): ApprovalChoices & { hidden: number } {
  const offered = offeredOptions(options, mode);
  return { ...approvalChoices(offered.options), hidden: offered.hidden };
}

/** Label for the "always" checkbox: the provider's own words, phrased as a grant. */
export function alwaysLabel(option: ApprovalOption): string {
  return /^always/i.test(option.label)
    ? option.label
    : option.kind === "allow_session"
      ? `Allow for the rest of this session`
      : `Always allow (${option.label})`;
}

export type RiskLevel = "high" | "medium";

const high: readonly RegExp[] = [
  /\bgit\s+push\b.*(--force\b|--force-with-lease\b|\s-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/,
  /\bsudo\b/,
  /\bdrop\s+(table|database)\b/i,
  /\bcurl\b[^|]*\|\s*(ba|z)?sh\b/,
  /\bchmod\s+-R\b/,
];
const medium: readonly RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(add|install|i)\b/,
  /\b(pip|pip3|brew|cargo|gem)\s+(install|add)\b/,
  /\bgit\s+push\b/,
  /\b(curl|wget)\b/,
  /\bdocker\s+(run|rm|system\s+prune)\b/,
];

/**
 * How careful to be with a shell command, from its text alone. Only commands that rewrite
 * history, delete recursively, escalate privileges or reach the network get a level; the
 * rest show their description without a risk word.
 */
export function commandRisk(command: string): RiskLevel | undefined {
  if (high.some((pattern) => pattern.test(command))) return "high";
  if (medium.some((pattern) => pattern.test(command))) return "medium";
  return undefined;
}

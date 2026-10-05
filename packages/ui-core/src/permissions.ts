import { permissionGuarantee, permissionModes } from "@ace/client";
import type {
  PermissionCapabilities,
  PermissionGuarantee,
  PermissionMode,
  PermissionState,
} from "@ace/protocol";

/** Strictest first, the order ADR 0061 ranks them in. */
export const permissionModeOrder: readonly PermissionMode[] = [
  "read-only",
  "ask",
  "auto-review",
  "full-access",
];

/** Each mode in one short line, so a menu row never wraps. */
const names: Record<PermissionMode, { label: string; description: string }> = {
  "read-only": { label: "Read only", description: "Reads and answers, never edits or runs" },
  ask: { label: "Ask first", description: "Asks before each edit, command or fetch" },
  "auto-review": { label: "Auto-review", description: "Approves low-risk actions, asks the rest" },
  "full-access": { label: "Full access", description: "Edits, runs and fetches without asking" },
};

export function permissionLabel(mode: PermissionMode): string {
  return names[mode].label;
}

const shortNames: Record<PermissionMode, string | undefined> = {
  "auto-review": undefined,
  "read-only": "Read-only",
  ask: "Ask",
  "full-access": "Full access",
};

/**
 * What the composer's approvals chip says beside its icon: nothing for the default mode
 * (Auto-review), a word or two for any other, so a thread off the default reads as such.
 */
export function permissionShortLabel(mode: PermissionMode): string | undefined {
  return shortNames[mode];
}

/** Full access turns review off, so it is the one mode that asks for attention. */
export function permissionNeedsAttention(mode: PermissionMode): boolean {
  return mode === "full-access";
}

const gateNames: [keyof PermissionGuarantee["gates"], string][] = [
  ["writes", "edits"],
  ["shell", "shell commands"],
  ["network", "network"],
  ["protectedReads", "protected reads"],
];

function listed(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * What the provider can actually hold back in `mode`, in one line: "Protected reads not gated".
 * Missing metadata is unknown, never a claim of full protection (ADR 0061).
 */
export function permissionCoverage(
  capabilities: PermissionCapabilities | undefined,
  mode: PermissionMode,
): string {
  if (mode === "full-access") return "Nothing is gated";
  const guarantee = permissionGuarantee(capabilities, mode);
  if (!guarantee) return "Coverage not reported by this provider";
  const open = gateNames.filter(([gate]) => !guarantee.gates[gate]).map(([, name]) => name);
  if (!open.length) return `Gates ${listed(gateNames.map(([, name]) => name))}`;
  const line = `${listed(open)} not gated`;
  return line[0]?.toUpperCase() + line.slice(1);
}

/**
 * What the provider gates, said once under the approval modes: that it doesn't report it, or
 * what `mode` (the one in effect) holds back.
 */
export function permissionCoverageNote(
  capabilities: PermissionCapabilities | undefined,
  provider: string,
  mode: PermissionMode | undefined,
): string {
  const reported = permissionModeOrder.some(
    (each) => each !== "full-access" && permissionGuarantee(capabilities, each) !== undefined,
  );
  if (!reported) return `${provider} doesn't report what each mode gates`;
  if (!mode) return `${provider} reports what each mode gates`;
  return `${names[mode].label}: ${permissionCoverage(capabilities, mode)}`;
}

export interface PermissionChoice {
  mode: PermissionMode;
  label: string;
  description: string;
  coverage: string;
  attention: boolean;
}

/** The modes the provider supports, strictest first; none when it reports no modes. */
export function permissionChoices(
  capabilities: PermissionCapabilities | undefined,
): PermissionChoice[] {
  const supported = new Set(permissionModes(capabilities));
  return permissionModeOrder
    .filter((mode) => supported.has(mode))
    .map((mode) => ({
      mode,
      label: names[mode].label,
      description: names[mode].description,
      coverage: permissionCoverage(capabilities, mode),
      attention: permissionNeedsAttention(mode),
    }));
}

export interface PermissionSummary {
  /** The mode the composer shows: a pending override, else what applies now. */
  mode: PermissionMode;
  label: string;
  attention: boolean;
  coverage: string;
  /** Chosen, but the agent is mid-turn: it applies from the next turn. */
  pending: boolean;
  /** No override: the mode comes from the project or global default. */
  inherited: boolean;
}

/** A thread's permission as the composer's chip and tooltip read it. */
export function threadPermissionSummary(
  state: PermissionState | undefined,
  capabilities: PermissionCapabilities | undefined,
): PermissionSummary | undefined {
  if (!state) return undefined;
  const mode = state.override ?? state.effective;
  return {
    mode,
    label: permissionLabel(mode),
    attention: permissionNeedsAttention(mode),
    coverage: permissionCoverage(capabilities, mode),
    pending: state.pending && state.override !== null && state.override !== state.effective,
    inherited: state.override === null,
  };
}

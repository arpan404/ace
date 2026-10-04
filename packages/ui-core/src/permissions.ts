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

const names: Record<PermissionMode, { label: string; description: string }> = {
  "read-only": {
    label: "Read only",
    description: "Reads and answers. Never edits files or runs commands.",
  },
  ask: { label: "Ask first", description: "Asks you before each edit, command or network call." },
  "auto-review": {
    label: "Auto-review",
    description: "ace approves low-risk actions and asks you about the rest.",
  },
  "full-access": {
    label: "Full access",
    description: "Edits, runs commands and uses the network without asking.",
  },
};

export function permissionLabel(mode: PermissionMode): string {
  return names[mode].label;
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

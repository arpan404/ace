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

const shortNames: Record<PermissionMode, string> = {
  "auto-review": "Auto-review",
  "read-only": "Read-only",
  ask: "Ask",
  "full-access": "Full access",
};

/**
 * What the composer's approvals chip says beside its icon: a word or two for every mode, the
 * default (Auto-review) included, so the chip always says which mode the thread is in.
 */
export function permissionShortLabel(mode: PermissionMode): string {
  return shortNames[mode];
}

/**
 * The chip's words: the mode in effect, and while a change waits for the agent's next turn both,
 * "Auto-review → Full access".
 */
export function permissionChipText(mode: PermissionMode, next: PermissionMode | undefined): string {
  return next ? `${shortNames[mode]} → ${shortNames[next]}` : shortNames[mode];
}

/**
 * Why a chosen mode isn't in effect yet. The daemon may one day say the agent is mid-command
 * (`busy`), where the change waits for that command rather than for the next turn.
 */
export type PermissionWait = "busy";

/** When a chosen mode takes over, in the chip's tooltip. */
export function permissionPendingNote(wait?: PermissionWait | undefined): string {
  return wait === "busy"
    ? "Applies when the running command finishes"
    : "Applies at the agent's next turn";
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
  /** The mode in effect now: what the agent runs under until a change applies. */
  mode: PermissionMode;
  label: string;
  attention: boolean;
  coverage: string;
  /** The mode chosen to replace it, waiting for the agent's next turn; undefined when none. */
  next: PermissionMode | undefined;
  /** No override: the mode comes from the project or global default. */
  inherited: boolean;
}

/**
 * A thread's permission as the composer's chip and tooltip read it: the effective mode, and the
 * one waiting to replace it. `chosen` is a change this device made that the daemon hasn't
 * reported yet (`null`: back to the default), shown at once rather than after the round trip.
 * `defaultMode` is what a thread without an override follows, so "Use the default" can say what
 * it becomes.
 */
export function threadPermissionSummary(
  state: PermissionState | undefined,
  capabilities: PermissionCapabilities | undefined,
  options: {
    chosen?: PermissionMode | null | undefined;
    defaultMode?: PermissionMode | undefined;
  } = {},
): PermissionSummary | undefined {
  if (!state) return undefined;
  const mode = state.effective;
  const local = options.chosen !== undefined;
  const override = local ? (options.chosen ?? null) : state.override;
  const target = override ?? options.defaultMode;
  const waiting = local || state.pending;
  return {
    mode,
    label: permissionLabel(mode),
    attention: permissionNeedsAttention(mode),
    coverage: permissionCoverage(capabilities, mode),
    next: waiting && target !== undefined && target !== mode ? target : undefined,
    inherited: override === null,
  };
}

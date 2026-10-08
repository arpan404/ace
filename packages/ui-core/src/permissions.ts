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
  ask: { label: "Ask first", description: "Requires approval for edits and risky actions" },
  "auto-review": { label: "Auto-review", description: "Approves low-risk actions, asks the rest" },
  "full-access": { label: "Full access", description: "Edits, runs and fetches without asking" },
};

export function permissionLabel(mode: PermissionMode): string {
  return names[mode].label;
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
  /** Why the provider can't run in this mode; the menu shows it disabled with this line. */
  unavailable?: string | undefined;
}

/**
 * Why `provider` can't run in `mode`, or undefined when it can or hasn't said which modes it
 * has (unknown is never a refusal). Ask needs the agent to stop before acting until a person
 * answers; Cursor and generic ACP agents can't (ADR 0061), and the daemon refuses it for them.
 */
export function permissionUnavailable(
  capabilities: PermissionCapabilities | undefined,
  mode: PermissionMode,
  provider: string,
): string | undefined {
  if (!capabilities?.modes.length || permissionModes(capabilities).includes(mode)) return undefined;
  return mode === "ask"
    ? `${provider} can't pause for your approval`
    : `${provider} has no ${names[mode].label.toLowerCase()} mode`;
}

/**
 * The mode a thread runs under when `mode` can't be honoured: the nearest stricter mode the
 * provider has, else the nearest looser one short of full access, which is never a fallback.
 * Undefined when nothing fits; `mode` itself when the provider supports it or hasn't said.
 */
export function permissionFallback(
  capabilities: PermissionCapabilities | undefined,
  mode: PermissionMode,
): PermissionMode | undefined {
  const supported = permissionModes(capabilities);
  if (!capabilities?.modes.length || supported.includes(mode)) return mode;
  const at = permissionModeOrder.indexOf(mode);
  const stricter = permissionModeOrder.slice(0, at).findLast((each) => supported.includes(each));
  const looser = permissionModeOrder
    .slice(at + 1)
    .find((each) => each !== "full-access" && supported.includes(each));
  return stricter ?? looser;
}

/** The mode a new thread is sent with, and why it isn't the one asked for. */
export interface PermissionAdmission {
  /** What to send: `requested`, or its fallback when the provider can't run in it. */
  mode: PermissionMode | undefined;
  /** Shown beside the chip when the request can't run as asked; undefined when it can. */
  fallback: string | undefined;
}

/**
 * What a new thread starts in when `requested` (chosen here, or the default) may not suit its
 * provider: an unsupported mode is never sent, its fallback is, and the person is told why.
 */
export function permissionAdmission(
  capabilities: PermissionCapabilities | undefined,
  requested: PermissionMode | undefined,
  provider: string,
): PermissionAdmission {
  const reason = requested && permissionUnavailable(capabilities, requested, provider);
  if (!requested || !reason) return { mode: requested, fallback: undefined };
  const mode = permissionFallback(capabilities, requested);
  return {
    mode,
    fallback: mode
      ? `${reason}, so the thread starts in ${names[mode].label}`
      : `${reason}; choose another mode`,
  };
}

/**
 * The modes the provider supports, strictest first; none when it reports no modes. Ask is
 * offered disabled, with why, when the provider can't honour it, so its absence isn't a puzzle.
 */
export function permissionChoices(
  capabilities: PermissionCapabilities | undefined,
  provider = "This provider",
): PermissionChoice[] {
  const supported = new Set(permissionModes(capabilities));
  if (!supported.size) return [];
  return permissionModeOrder
    .filter((mode) => supported.has(mode) || mode === "ask")
    .map((mode) => ({
      mode,
      label: names[mode].label,
      description: names[mode].description,
      coverage: permissionCoverage(capabilities, mode),
      attention: permissionNeedsAttention(mode),
      unavailable: permissionUnavailable(capabilities, mode, provider),
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

/**
 * How much a mode lets the agent do without asking: `high` (nothing gated) draws the composer's
 * approvals icon in the attention colour.
 */
export type PermissionRisk = "low" | "medium" | "high";

/**
 * One approval mode as the composer lists it, whoever defines it: ace's own modes today, each
 * provider's native ones later. The composer's icon and menu read only this.
 */
export interface PermissionOption {
  id: string;
  label: string;
  description: string;
  risk: PermissionRisk;
  /** Why it can't be chosen for this provider; the menu shows it disabled with this line. */
  unavailable?: string | undefined;
}

const risks: Record<PermissionMode, PermissionRisk> = {
  "read-only": "low",
  ask: "low",
  "auto-review": "medium",
  "full-access": "high",
};

/** One of ace's modes as a composer option. */
export function permissionOption(mode: PermissionMode): PermissionOption {
  return { id: mode, ...names[mode], risk: risks[mode] };
}

/**
 * The adapter from ace's modes to the composer's generic list: the modes `provider` supports,
 * strictest first, Ask disabled with why where it can't be honoured. Replaced by the provider's
 * native list when the daemon advertises one.
 */
export function permissionOptions(
  capabilities: PermissionCapabilities | undefined,
  provider = "This provider",
): PermissionOption[] {
  return permissionChoices(capabilities, provider).map((choice) =>
    Object.assign(permissionOption(choice.mode), { unavailable: choice.unavailable }),
  );
}

/** The ace mode an option id names, or undefined for an id that isn't one. */
export function permissionModeOf(id: string): PermissionMode | undefined {
  return permissionModeOrder.find((mode) => mode === id);
}

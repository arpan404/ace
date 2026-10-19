import type {
  AccessMode,
  AccessModeOffer,
  NativePermissionMode,
  PermissionState,
} from "@ace/protocol";
import { accessModeOrder, stricterOffer } from "@ace/provider-kit/access-modes";

/** ace's four access modes as people read them (ADR 0075), least capable first. */
export const accessModes: readonly AccessMode[] = accessModeOrder;
const copy: Record<AccessMode, { label: string; description: string }> = {
  "read-only": { label: "Read-only", description: "Reads and plans. No changes." },
  ask: { label: "Ask", description: "Asks before edits and commands." },
  "auto-review": { label: "Auto review", description: "Edits freely. Risky actions get checked." },
  "full-access": { label: "Full access", description: "No prompts, no sandbox." },
};

export function accessLabel(mode: AccessMode): string {
  return copy[mode].label;
}
export function accessDescription(mode: AccessMode): string {
  return copy[mode].description;
}
/** Full access gates nothing; it reads in the attention colour wherever it shows. */
export function accessAttention(mode: AccessMode | null | undefined): boolean {
  return mode === "full-access";
}

export interface AccessChoice {
  mode: AccessMode;
  label: string;
  description: string;
  attention: boolean;
}
/** The modes a provider genuinely supports; the rest aren't shown at all. */
export function accessChoices(offers: readonly AccessModeOffer[] | undefined): AccessChoice[] {
  return (offers ?? []).map(({ mode }) => ({
    mode,
    label: copy[mode].label,
    description: copy[mode].description,
    attention: accessAttention(mode),
  }));
}

/**
 * The mode a requested default runs as on a provider: itself when supported, else the nearest
 * stricter mode it supports. Undefined when nothing that strict is supported.
 */
export function supportedAccess(
  requested: AccessMode,
  offers: readonly AccessModeOffer[] | undefined,
): AccessMode | undefined {
  return stricterOffer(requested, offers ?? [])?.mode;
}

/** A native selector's name for Settings → Providers → Advanced. */
export function permissionModeLabel(entry: NativePermissionMode): string {
  return entry.presentation === "full-access" ? "Full access" : entry.label;
}

export function permissionPendingNote(): string {
  return "Applies at the agent's next turn";
}

export interface AccessSummary {
  /** The mode in effect; null while the provider runs its own default or a Custom mode. */
  mode: AccessMode | null;
  /** "Ask", "Custom", or "Agent default". */
  label: string;
  attention: boolean;
  /** The mode chosen to replace it, not in effect yet. */
  next: AccessMode | undefined;
  /** The native mode an Advanced override runs, for the tooltip. */
  custom: string | undefined;
  /** The thread follows its project's or this daemon's default. */
  inherited: boolean;
  /** Why the mode in effect is stricter than the default it follows. */
  stricter: string | undefined;
}

/**
 * A thread's access chip: the mode in effect, a pending change, and — when a default had to
 * step down to a stricter mode the provider supports — a short reason for the tooltip.
 */
export function threadAccessSummary(
  state: PermissionState | undefined,
  offers: readonly AccessModeOffer[] | undefined,
  options: {
    chosen?: AccessMode | null | undefined;
    defaultMode?: AccessMode | undefined;
    provider?: string | undefined;
  } = {},
): AccessSummary | undefined {
  if (!state) return undefined;
  const override = options.chosen !== undefined ? options.chosen : state.override;
  const wanted = override ?? options.defaultMode;
  const target = wanted ? supportedAccess(wanted, offers) : undefined;
  const mode = state.effective ?? (state.custom ? null : (target ?? null));
  const next =
    (options.chosen !== undefined || state.pending) && target && target !== mode
      ? target
      : undefined;
  const shown = next ?? mode;
  const stricter =
    wanted && shown && shown !== wanted && !state.custom
      ? `${copy[wanted].label} isn't available${options.provider ? ` for ${options.provider}` : ""}`
      : undefined;
  return {
    mode,
    label: state.custom ? "Custom" : mode ? copy[mode].label : "Agent default",
    attention: accessAttention(mode),
    next,
    custom: state.custom,
    inherited: override === null,
    stricter,
  };
}

/** New thread's access: what runs, what the chip says, and what `thread.create` carries. */
export interface NewThreadAccess {
  /** The person's choice, else the project's default, else the daemon's. */
  wanted: AccessMode | undefined;
  /** The mode it runs as on this provider: the wanted one, or the nearest stricter one. */
  admitted: AccessMode | undefined;
  summary: AccessSummary | undefined;
  /** Send waits: the provider has nothing as strict as the mode asked for. */
  problem: string | undefined;
  /** The `access` the create carries; undefined lets the daemon apply its default. */
  permission: AccessMode | undefined;
}

/**
 * Access for a thread that hasn't started (ADR 0075). The draft's own choice wins over the
 * project's default, which wins over this daemon's. A mode the provider can't express runs as
 * the nearest stricter mode it supports, never a looser one. Before the provider's modes are
 * read only a mode picked here is sent; otherwise the daemon applies the defaults itself.
 */
export function newThreadAccess(input: {
  chosen: AccessMode | undefined;
  projectDefault: AccessMode | undefined;
  daemonDefault: AccessMode | undefined;
  offers: readonly AccessModeOffer[];
  /** The provider's display name, once known. */
  provider: string | undefined;
}): NewThreadAccess {
  const defaultMode = input.projectDefault ?? input.daemonDefault;
  const wanted = input.chosen ?? defaultMode;
  const admitted = wanted ? supportedAccess(wanted, input.offers) : undefined;
  const summary = threadAccessSummary(
    { override: input.chosen ?? null, effective: admitted ?? null, pending: false },
    input.offers,
    { ...(defaultMode ? { defaultMode } : {}), provider: input.provider },
  );
  const problem =
    input.provider && wanted && input.offers.length && !admitted
      ? `${input.provider} has nothing as strict as ${accessLabel(wanted)}. Choose its access before sending.`
      : undefined;
  const permission = admitted ?? (input.offers.length ? undefined : input.chosen);
  return { wanted, admitted, summary, problem, permission };
}

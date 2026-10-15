import type { CursorLimits } from "@ace/adapter-cursor";
import type { ProviderConfiguration } from "@ace/protocol";

export const DEFAULT_CHECKPOINT_MB = 32;
/** Matches `Limits.maxCheckpointBytes` max (256 MiB) in `@ace/adapter-cursor`. */
export const MAX_CHECKPOINT_MB = 256;

/**
 * Settings UI value (MiB) → per-session `Limits` override for Cursor threads.
 * Returns `{}` when unset so the adapter falls back to daemon options, then the
 * 32 MiB schema default. A set value wins over daemon options: it is the live,
 * user-visible knob, read on every thread open without a daemon restart.
 */
export function cursorCheckpointLimitOverride(
  config: Pick<ProviderConfiguration, "maxCheckpointMb"> | undefined,
): Partial<CursorLimits> {
  const mb = config?.maxCheckpointMb;
  if (mb === undefined) return {};
  const clamped = Math.min(Math.max(1, Math.floor(mb)), MAX_CHECKPOINT_MB);
  return { maxCheckpointBytes: clamped * 1048576 };
}

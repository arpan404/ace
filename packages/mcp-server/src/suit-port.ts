import type { McpAttribution } from "@ace/protocol";
import type { SuitId, SuitLiveReport, SuitSummary } from "@ace/protocol/suits";

/**
 * What `suit_apply` needs from the daemon (ADR 0150): its Suit library and the person's look on
 * their devices. The daemon implements it; this package only decides what to call when.
 */
export interface SuitPort {
  /**
   * Re-runs every check on `~/.ace/suits/<id>/` as it is on disk now (the library's `validate`).
   * `problems` is empty when the Suit can be applied. Undefined when no Suit has this id.
   */
  validate(id: SuitId, signal: AbortSignal): Promise<SuitSummary | undefined>;
  /**
   * Shows a Suit on the calling person's devices without storing it, over whatever they keep;
   * `null` ends the preview and they show their kept look again. Never persisted, so a daemon
   * restart ends a preview by itself.
   */
  preview(caller: McpAttribution, id: SuitId | null): Promise<void>;
  /**
   * Stores a Suit as the person's look (`appearance.suit`) on their devices and ends any preview.
   * Returns how to put back what each device had before, for a one-step undo.
   */
  keep(caller: McpAttribution, id: SuitId): Promise<{ restore(): Promise<void> }>;
  /**
   * Asks the calling person's devices that show `id` to check it as rendered, and waits a
   * bounded time for their reports. Empty when no device answered in time.
   */
  liveCheck(caller: McpAttribution, id: SuitId, signal: AbortSignal): Promise<SuitLiveReport[]>;
}

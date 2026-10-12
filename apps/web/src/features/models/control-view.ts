import type { ProviderKind } from "@ace/protocol";
import type { PickerModel, PickerProvider, Speed, SpeedTier } from "@ace/ui-core";

/** One account the chosen model can run on, for the popover's account row. */
export interface AccountRow {
  id: string;
  /** The quiet tag, "personal". */
  label: string;
  authMethod?: string | undefined;
  /** Its usage ("38% of 5-hour used"), or when it resets after hitting its limit. */
  detail: string;
  /** Set when it can't take work now. */
  disabled?: string | undefined;
}

import type { CatalogState } from "@/lib/model-catalog.ts";

export type { CatalogState };

/**
 * Everything the composer's model chip and its popover show, the same shape for New thread and
 * a running thread. Each side maps its own data into it; the chip only draws it.
 */
export interface ModelControlView {
  provider: ProviderKind | undefined;
  /** The model's display name; undefined until one is known. */
  label: string | undefined;
  /** What the chip says without a model ("Loading models…"). */
  placeholder: string;
  unavailable?: string | undefined;
  pickerRequest?: number | undefined;
  /** The chip's accessible name and tooltip. */
  ariaLabel: string;
  tip: string;
  /**
   * A switch to `label` not in effect yet: the model it leaves (the chip reads "Opus 4.1 →
   * Sonnet 4.5"; undefined when only the account changes) and when it applies.
   */
  switching?: { from: string | undefined; description: string } | undefined;
  /** Offline: changes still go and apply once the daemon is back; the popover says so. */
  offline?: string | undefined;
  /** No model can be chosen at all (no provider installed). */
  disabled?: boolean | undefined;
  /** The chosen model's picker key. */
  modelKey: string | undefined;
  /** The account (catalog instance) it runs on, when known. */
  instance?: string | undefined;
  efforts: readonly string[];
  /** The effort in effect, or the model's default. */
  effort: string | undefined;
  /** The model's own default effort, marked on the slider. */
  defaultEffort: string | undefined;
  /** `effort` is the default rather than a choice the provider reported. */
  effortDefault: boolean;
  /** Why effort can't change here. */
  effortReason: string | undefined;
  /** The model's speeds, slowest first; the control shows them only when there are two or more. */
  speeds: readonly SpeedTier[];
  /** The speed in effect. */
  speed: Speed;
  /** Why speed can't change here (no faster tier, or not on a running thread). */
  speedReason: string | undefined;
  /** The effort differs from the model's default; Reset goes back to it (speed stays). */
  canReset: boolean;
  /** Shown only when more than one can run the model. */
  accounts: readonly AccountRow[];
  account: string | undefined;
  accountLabel?: string | undefined;
  models: readonly PickerModel[];
  providers: readonly PickerProvider[];
  catalog: CatalogState;
}

export interface ModelControlActions {
  /** An effort level, or undefined for the provider's default. */
  onEffort(effort: string | undefined): void;
  onSpeed(speed: Speed): void;
  /**
   * A picked model, on the account its row was listed under (undefined: keep the account);
   * false when the popover should close (a dialog asks first).
   */
  onModel(key: string, instance: string | undefined): boolean;
  onAccount(id: string): void;
}

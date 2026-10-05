import type { ProviderKind } from "@ace/protocol";
import type { PickerModel, PickerProvider } from "@ace/ui-core";

/** One account the chosen model can run on, for the popover's account row. */
export interface AccountRow {
  id: string;
  /** The quiet tag, "personal". */
  label: string;
  /** Its usage ("38% of 5-hour used"), or when it resets after hitting its limit. */
  detail: string;
  /** Set when it can't take work now. */
  disabled?: string | undefined;
}

/**
 * Where the model list stands: still arriving (the picker shows placeholder rows), being
 * discovered again with the last list shown meanwhile, or settled.
 */
export type CatalogState = "loading" | "refreshing" | "ready";

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
  /** The chip's accessible name and tooltip. */
  ariaLabel: string;
  tip: string;
  /** Nothing can change now (offline): the chip dims and the popover says why. */
  offline?: string | undefined;
  /** No model can be chosen at all (no provider installed). */
  disabled?: boolean | undefined;
  /** The chosen model's picker key. */
  modelKey: string | undefined;
  efforts: readonly string[];
  /**
   * The model has no default ace knows of: the slider starts with a "Default" stop, the
   * provider's own default, which is also where it sits until an effort is picked.
   */
  defaultStop: boolean;
  /** The effort in effect, or the model's default. */
  effort: string | undefined;
  /** `effort` is the default rather than a choice the provider reported. */
  effortDefault: boolean;
  /** Why effort can't change here. */
  effortReason: string | undefined;
  fast: boolean;
  /** Why speed can't change here (no faster tier, or not on a running thread). */
  fastReason: string | undefined;
  /** Effort or speed differ from the model's defaults. */
  canReset: boolean;
  /** Shown only when more than one can run the model. */
  accounts: readonly AccountRow[];
  account: string | undefined;
  models: readonly PickerModel[];
  providers: readonly PickerProvider[];
  catalog: CatalogState;
}

export interface ModelControlActions {
  /** An effort level, or undefined for the provider's default. */
  onEffort(effort: string | undefined): void;
  onFast(on: boolean): void;
  onReset(): void;
  /** A picked model; false when the popover should close (a dialog asks first). */
  onModel(key: string): boolean;
  onAccount(id: string): void;
}

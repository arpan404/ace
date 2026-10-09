import {
  accountDisplayName,
  modelControlName,
  pickerModel,
  pickerProviders,
  speedControl,
  speedOffTier,
  type PickerModel,
} from "@ace/ui-core";
import {
  ModelControl,
  useModelCatalogState,
  type ModelControlView,
} from "@/features/models/index.ts";
import { composerChip, useComposerCompact } from "@/features/thread/index.ts";
import { useProviderStatuses } from "@/lib/provider-statuses.ts";
import type { NewThreadOptions, Resolved } from "./choices.ts";

/**
 * New thread's model chip, the same one the thread's composer shows: model and effort on the
 * chip; effort, speed, the account and the model picker in its popover.
 */
export function ModelPicker(props: {
  options: NewThreadOptions | undefined;
  resolved: Resolved;
  /**
   * Called with the option's `key`, which tells apart providers that share a model id, and the
   * account its row was listed under (undefined: keep the account).
   */
  onModel(key: string, account: string | undefined): void;
  onAccount(id: string): void;
  onEffort(effort: string | undefined): void;
  onFast(on: boolean): void;
  onReset(): void;
}) {
  const { model, account, effort, fast, provider } = props.resolved;
  const compact = useComposerCompact();
  const statuses = useProviderStatuses();
  const catalog = useModelCatalogState();
  // Say what's missing rather than wait for models that won't come or make one up.
  const none = props.options !== undefined && props.options.models.length === 0;
  const installed = (statuses.data ?? []).some((status) => status.state !== "not_installed");
  const empty = !props.options
    ? { label: "Loading models…", aria: "loading" }
    : none && !installed
      ? { label: "No provider CLI installed", aria: "no provider installed" }
      : none
        ? { label: "No models available", aria: "no models available" }
        : {
            label: `No models on ${account ? accountDisplayName(account.label) : "this account"}`,
            aria: "no models on this account",
          };
  const tag = account ? accountDisplayName(account.label) : undefined;
  const efforts = model?.efforts ?? [];
  const speed = speedControl({
    model: model && {
      label: model.label,
      provider: model.provider,
      fastTier: model.fastTier,
      fastDefault: model.fastDefault,
    },
    current: fast ? model?.fastTier : speedOffTier(model),
  });
  const details = model && {
    model: model.label,
    account: tag,
    effort,
    hasEfforts: efforts.length > 0,
    fast: speed.on,
  };
  const name = details && modelControlName(details);
  // Each account's rows: the picker groups them by account and source.
  const models: PickerModel[] = (props.options?.models ?? []).map((option) =>
    pickerModel(option, option.label, option.account),
  );
  const view: ModelControlView = {
    provider,
    side: "bottom",
    accountLabel:
      (props.options?.accounts.filter((option) => option.provider === provider).length ?? 0) > 1
        ? tag
        : undefined,
    label: model?.label,
    placeholder: empty.label,
    ariaLabel: `Model: ${name ?? empty.aria}`,
    tip: details ? modelControlName({ ...details, provider: model.provider }) : empty.label,
    // An account without models can still move to another model or account.
    disabled: !model && (props.options === undefined || none),
    modelKey: model?.key,
    instance: model?.account,
    efforts,
    effort,
    effortDefault: false,
    effortReason: model && !efforts.length ? `${model.label} has no effort levels` : undefined,
    fast: speed.on,
    fastReason: speed.reason,
    canReset: effort !== model?.defaultEffort || speed.on !== !!model?.fastDefault,
    accounts: (props.options?.accounts ?? [])
      .filter((option) => option.provider === provider)
      .map((option) => ({
        id: option.id,
        authMethod: option.authMethod,
        label: accountDisplayName(option.label),
        detail: option.usage,
      })),
    account: account?.id,
    models,
    providers: pickerProviders(models, statuses.data ?? []),
    // New thread waits for the catalog before the chip opens; the accounts and providers too.
    catalog: props.options ? catalog : "loading",
  };
  return (
    <ModelControl
      view={view}
      className={composerChip}
      compact={compact}
      actions={{
        onEffort: props.onEffort,
        onFast: props.onFast,
        onReset: props.onReset,
        onModel: (key, listed) => {
          props.onModel(key, listed);
          return true;
        },
        onAccount: props.onAccount,
      }}
    />
  );
}

import {
  accountTag,
  modelControlName,
  pickerProviders,
  providerNames,
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
  /** Called with the option's `key`, which tells apart providers that share a model id. */
  onModel(key: string): void;
  onAccount(id: string): void;
  onEffort(effort: string | undefined): void;
  onFast(on: boolean): void;
  onReset(): void;
}) {
  const { model, account, effort, fast } = props.resolved;
  const compact = useComposerCompact();
  const statuses = useProviderStatuses();
  const catalog = useModelCatalogState();
  // Discovery found no provider CLI: say so rather than waiting for models that won't come.
  const none = props.options !== undefined && props.options.models.length === 0;
  const empty = none ? "No provider CLI installed" : "Loading models…";
  const tag = account ? accountTag(account.label) : undefined;
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
  const name = model
    ? modelControlName({
        model: model.label,
        account: tag,
        effort,
        hasEfforts: efforts.length > 0,
        fast: speed.on,
      })
    : undefined;
  const models: PickerModel[] = (props.options?.models ?? []).map((option) => ({
    key: option.key,
    provider: option.provider,
    label: option.label,
    isNew: option.isNew,
    legacy: option.legacy,
  }));
  const view: ModelControlView = {
    provider: model?.provider,
    label: model?.label,
    placeholder: empty,
    ariaLabel: `Model: ${name ?? (none ? "no provider installed" : "loading")}`,
    tip: model ? [providerNames[model.provider], name].join(" · ") : empty,
    disabled: !model,
    modelKey: model?.key,
    efforts,
    defaultStop: model?.defaultEffort === undefined,
    effort,
    effortDefault: false,
    effortReason: model && !efforts.length ? `${model.label} has no effort levels` : undefined,
    fast: speed.on,
    fastReason: speed.reason,
    canReset: effort !== model?.defaultEffort || speed.on !== !!model?.fastDefault,
    accounts: (props.options?.accounts ?? [])
      .filter((option) => option.provider === model?.provider)
      .map((option) => ({ id: option.id, label: accountTag(option.label), detail: option.usage })),
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
        onModel: (key) => {
          props.onModel(key);
          return true;
        },
        onAccount: props.onAccount,
      }}
    />
  );
}

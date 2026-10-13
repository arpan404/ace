import { ProviderReadError, useProviderReadError } from "@/components/provider-read-error.tsx";
import {
  accountDisplayName,
  modelControlName,
  pickerModel,
  pickerProviders,
  speedControl,
  speedOption,
  type PickerModel,
  type Speed,
} from "@ace/ui-core";
import {
  ModelControl,
  useModelCatalogState,
  type ModelControlView,
} from "@/features/models/index.ts";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useCatalogQuery } from "@/lib/model-catalog.ts";
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
  onSpeed(speed: Speed): void;
}) {
  const { model, account, effort, provider } = props.resolved;
  const compact = useComposerCompact();
  const readError = useProviderReadError();
  const statuses = useProviderStatuses();
  const catalog = useModelCatalogState();
  const catalogQuery = useCatalogQuery();
  // Say what's missing rather than wait for models that won't come or make one up.
  const none = props.options !== undefined && props.options.models.length === 0;
  const installed = (statuses.data ?? []).some((status) => status.state !== "not_installed");
  const error = catalogQuery.isError
    ? "Couldn't load models"
    : statuses.isError
      ? "Couldn't check providers"
      : undefined;
  const empty = error
    ? { label: error, aria: error }
    : !props.options || (none && catalog === "refreshing")
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
      speeds: model.speeds,
      defaultSpeed: model.defaultSpeed,
    },
    current: model && speedOption(model.speeds, props.resolved.speed),
  });
  const details = model && {
    model: model.label,
    account: tag,
    effort,
    hasEfforts: efforts.length > 0,
    speed: speed.speed,
  };
  const name = details && modelControlName(details);
  // Each account's rows: the picker groups them by account and source.
  const models: PickerModel[] = (props.options?.models ?? []).map((option) =>
    pickerModel(option, option.label, option.account),
  );
  const view: ModelControlView = {
    provider,
    accountLabel:
      (props.options?.accounts.filter((option) => option.provider === provider).length ?? 0) > 1
        ? tag
        : undefined,
    label: error ? undefined : model?.label,
    placeholder: empty.label,
    ariaLabel: `Model: ${error ?? name ?? empty.aria}`,
    tip:
      error ?? (details ? modelControlName({ ...details, provider: model.provider }) : empty.label),
    // An account without models can still move to another model or account.
    disabled: !!error || props.options === undefined,
    modelKey: model?.key,
    instance: model?.account,
    efforts,
    effort,
    defaultEffort: model?.defaultEffort,
    effortDefault: false,
    effortReason: model && !efforts.length ? `${model.label} has no effort levels` : undefined,
    speeds: speed.tiers,
    speed: speed.speed,
    speedReason: speed.reason,
    canReset: effort !== model?.defaultEffort,
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
  const problem = readError.providers ?? readError.models;
  if (!model && problem) return <ProviderReadError message={problem} retry={readError.retry} />;
  return (
    <>
      <ModelControl
        view={view}
        className={composerChip}
        compact={compact}
        actions={{
          onEffort: props.onEffort,
          onSpeed: props.onSpeed,
          onModel: (key, listed) => {
            props.onModel(key, listed);
            return true;
          },
          onAccount: props.onAccount,
        }}
      />
      {error && (
        <IconButton
          icon={ArrowClockwiseIcon}
          label="Retry loading models"
          size="sm"
          onClick={readError.retry}
        />
      )}
    </>
  );
}

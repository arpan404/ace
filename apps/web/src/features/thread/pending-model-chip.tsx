import type { ProviderKind } from "@ace/protocol";
import { modelLabel, optionEffort, resolveEffort } from "@ace/ui-core";
import {
  ModelControl,
  useModelCatalogState,
  useModelChoices,
  type ModelControlActions,
  type ModelControlView,
} from "@/features/models/index.ts";
import { useComposerCompact } from "./composer/composer-compact.ts";
import { chipControl } from "./composer/composer-styles.ts";

const inert: ModelControlActions = {
  onEffort: () => {},
  onSpeed: () => {},
  onModel: () => false,
  onAccount: () => {},
};

/**
 * The model a new thread starts on, while its worktree is made: the same chip every composer
 * has (provider mark, model, effort), disabled until the thread exists.
 */
export function PendingModelChip(props: {
  provider: ProviderKind | undefined;
  instanceId: string | undefined;
  model: string | undefined;
  options: Readonly<Record<string, unknown>> | undefined;
}) {
  const choices = useModelChoices();
  const catalog = useModelCatalogState();
  const compact = useComposerCompact();
  const named = (id: string) =>
    choices.filter(
      (choice) =>
        choice.provider === props.provider &&
        (choice.modelId === id || choice.aliases.includes(id)),
    );
  const matches = props.model ? named(props.model) : [];
  const choice =
    matches.find((entry) => entry.accountId === props.instanceId) ??
    matches[0] ??
    // No model named: the provider's default, as New thread showed it.
    (props.model
      ? undefined
      : choices.find((entry) => entry.provider === props.provider && entry.isDefault));
  const label = choice?.model ?? (props.model ? modelLabel(props.model) : undefined);
  const efforts = choice?.efforts ?? [];
  const effort = efforts.length
    ? resolveEffort(efforts, optionEffort(props.options), choice?.defaultEffort)
    : undefined;
  const name = [label ?? "Provider default", effort].filter(Boolean).join(", ");
  const view: ModelControlView = {
    provider: props.provider,
    label,
    placeholder: "Provider default",
    ariaLabel: `Model: ${name}`,
    tip: "Model controls are available when the thread starts",
    disabled: true,
    modelKey: choice?.key,
    instance: props.instanceId,
    efforts,
    effort,
    defaultEffort: choice?.defaultEffort,
    effortDefault: optionEffort(props.options) === undefined,
    effortReason: "Available when the thread starts",
    speeds: [],
    speed: "standard",
    speedReason: "Available when the thread starts",
    canReset: false,
    accounts: [],
    account: undefined,
    models: [],
    providers: [],
    catalog,
  };
  return <ModelControl view={view} actions={inert} className={chipControl} compact={compact} />;
}

import { ProviderConfigurations, type ProviderKind } from "@ace/protocol";
import {
  modelKey,
  newThreadOptions,
  pickerGroups,
  pickerModel,
  type PickerGroup,
  type PickerModel,
} from "@ace/ui-core";
import { CaretRightIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { ModelField, useRefreshModels } from "@/features/model-picker/index.ts";
import { cn } from "@/lib/cn.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import {
  catalogKey,
  useModelCatalog,
  useModelCatalogState,
  useModelInstances,
} from "@/lib/model-catalog.ts";

const compact = new Intl.NumberFormat("en", { notation: "compact" });

/**
 * A provider's models on its page: its default model (ace's choice until the person picks one,
 * which then reads as theirs), how many it offers, and on request each source's models by name,
 * the older ones folded under Legacy models, with any discovery error beside the source it
 * concerns. Kept current by the catalog's `models.changed` pushes.
 */
export function ProviderModels(props: { provider: ProviderKind }) {
  const catalog = useModelCatalog();
  const state = useModelCatalogState();
  const instances = useModelInstances();
  const refresh = useRefreshModels();
  const [open, setOpen] = useState(false);
  const rows = (catalog ?? []).filter((model) => model.provider === props.provider);
  const context = new Map(rows.map((model) => [modelKey(model.provider, model.id), model]));
  const models = newThreadOptions(rows, [], []).models.map((option) =>
    pickerModel(option, option.label, option.account),
  );
  const groups = pickerGroups(models, instances, props.provider);
  const count = new Set(models.map((model) => model.key)).size;
  const problems = groups.some((group) => group.problems.length > 0);
  return (
    <div className="divide-y">
      <DefaultModel provider={props.provider} models={models} />
      <div className="flex min-h-12 items-center gap-2 px-4 py-2">
        <span className="min-w-0 flex-1 text-muted-foreground">
          {catalog === undefined
            ? "Loading models…"
            : count
              ? `${count} model${count === 1 ? "" : "s"} available`
              : "This CLI reported no models."}
        </span>
        {state === "refreshing" && <Spinner label="Refreshing models" />}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => refresh.refresh(props.provider)}
          disabled={refresh.pending || refresh.reason !== undefined}
          title={refresh.reason}
        >
          Refresh
        </Button>
        {groups.length > 0 && (
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide models" : problems ? "Show models and problems" : "Show models"}
            <CaretRightIcon
              aria-hidden
              size={10}
              weight="bold"
              className={cn("transition-transform duration-(--dur-1)", open && "rotate-90")}
            />
          </Button>
        )}
      </div>
      {open && (
        <ul aria-label="Models" className="fx-rise-in flex flex-col gap-3 px-4 py-3">
          {groups.map((group) => (
            <ModelGroup
              key={group.id}
              group={group}
              contextOf={(model) => context.get(model.key)?.contextWindow}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One source's models: its header and error, current ones, then a Legacy models fold. */
function ModelGroup(props: {
  group: PickerGroup;
  contextOf(model: PickerModel): number | undefined;
}) {
  const { group } = props;
  const [open, setOpen] = useState(false);
  const item = (model: PickerModel) => (
    <li key={model.key} className="flex items-baseline gap-2 text-ui">
      <span>{model.label}</span>
      {model.detail && (
        <span className="truncate text-xs text-subtle-foreground">{model.detail}</span>
      )}
      <span className="ml-auto shrink-0 text-sm text-subtle-foreground">
        {[
          model.isDefault ? (model.userDefault ? "Your default" : "Default") : "",
          props.contextOf(model) ? `${compact.format(props.contextOf(model) ?? 0)} context` : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </li>
  );
  return (
    <li role="group" aria-label={group.label ?? "Models"} className="flex flex-col gap-1">
      {group.label && (
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {group.label}
          {group.refreshing && <Spinner label={`Refreshing ${group.label}`} />}
        </span>
      )}
      {group.problems.map((problem) => (
        <p key={problem.message} className="flex gap-1.5 text-sm text-muted-foreground">
          {problem.severity !== "info" && (
            <WarningCircleIcon
              aria-hidden
              size={14}
              className="mt-0.5 shrink-0 text-status-failed"
            />
          )}
          <span>
            <span className="text-foreground">{problem.message}</span> {problem.hint}
          </span>
        </p>
      ))}
      <ul className="flex flex-col gap-1">{group.current.map(item)}</ul>
      {group.legacy.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="inline-flex w-fit items-center gap-1 rounded-sm text-sm text-muted-foreground focus-ring hover:text-foreground"
          >
            <CaretRightIcon
              aria-hidden
              size={10}
              weight="bold"
              className={cn("transition-transform duration-(--dur-1)", open && "rotate-90")}
            />
            Legacy models ({group.legacy.length})
          </button>
          {open && (
            <ul aria-label="Legacy models" className="flex flex-col gap-1 pl-3.5">
              {group.legacy.map(item)}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

/**
 * The provider's default model: ace's own choice (the newest flagship) until the person picks
 * another, any model including a legacy one; Reset goes back to ace's choice. New threads start
 * on it. Stored as `providers.configuration` `defaultModel` for the provider.
 */
function DefaultModel(props: { provider: ProviderKind; models: readonly PickerModel[] }) {
  const [stored, store] = useDaemonSetting("providers.configuration");
  const queryClient = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  // One row per model: the default is the provider's, whichever account lists it.
  const seen = new Set<string>();
  const models = props.models.flatMap((model) => {
    if (seen.has(model.key)) return [];
    seen.add(model.key);
    const account = !model.source || model.source.kind === "account";
    return [{ ...model, instance: undefined, ...(account ? { source: undefined } : {}) }];
  });
  const current =
    props.models.find((model) => model.isDefault && model.userDefault) ??
    props.models.find((model) => model.isDefault);
  if (!models.length) return null;
  const choose = async (id: string | null) => {
    const before = stored ?? [];
    const own = (entry: { provider: ProviderKind; instance?: string | undefined }) =>
      entry.provider === props.provider && entry.instance === undefined;
    const next = before.some(own)
      ? before.map((entry) => (own(entry) ? { ...entry, defaultModel: id } : entry))
      : [...before, { provider: props.provider, defaultModel: id }];
    setSaving(true);
    try {
      await store(ProviderConfigurations.parse(next));
      await queryClient.invalidateQueries({ queryKey: catalogKey });
    } catch (error) {
      toast.error({
        title: "Couldn't change the default model",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex min-h-12 items-center gap-2 px-4 py-2 text-ui">
      <span className="min-w-0 flex-1">Default model</span>
      <ModelField
        label="Default model"
        provider={props.provider}
        models={models}
        current={current?.key}
        value={current?.label ?? "None"}
        note={current?.userDefault ? "Your choice" : undefined}
        disabled={saving}
        className="max-w-56"
        onPick={(key) => void choose(key.slice(key.indexOf("\u0000") + 1))}
      />
      {current?.userDefault && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5"
          disabled={saving}
          onClick={() => void choose(null)}
        >
          Reset
        </Button>
      )}
    </div>
  );
}

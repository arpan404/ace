import { pluralCount } from "@ace/ui-core";
import { ProviderConfiguration, type CatalogModel, type ProviderKind } from "@ace/protocol";
import {
  modelKey,
  newThreadOptions,
  pickerModel,
  pickerGroups,
  type PickerModel,
} from "@ace/ui-core";
import { EyeIcon, EyeSlashIcon, StarIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import {
  GroupProblem,
  ModelField,
  useFavoriteModels,
  useRefreshModels,
} from "@/features/model-picker/index.ts";
import { useModelCatalog, useModelInstances } from "@/lib/model-catalog.ts";
import { useProviderConfiguration } from "@/lib/provider-configuration.ts";

export function ProviderModels(props: { provider: ProviderKind }) {
  const catalog = useModelCatalog();
  const preferences = useProviderConfiguration(props.provider);
  const instances = useModelInstances();
  const refresh = useRefreshModels();
  const stars = useFavoriteModels();
  const [open, setOpen] = useState(false);
  const rows = (catalog ?? []).filter((model) => model.provider === props.provider);
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  const models = newThreadOptions(rows, [], []).models.map((option) =>
    pickerModel(option, option.label, option.account),
  );
  const groups = pickerGroups(models, instances, props.provider);
  return (
    <>
      {groups.flatMap((group) =>
        group.problems.map((problem, index) => (
          <GroupProblem
            key={`${group.id}-${problem.code}-${problem.message}`}
            id={`${group.id}-${index}`}
            provider={props.provider}
            problem={problem}
          />
        )),
      )}
      <DefaultModel provider={props.provider} models={models} />
      <SettingRow title="Hide deprecated models" htmlFor="hide-deprecated" inline>
        <Switch
          id="hide-deprecated"
          checked={preferences.value?.hideDeprecated !== false}
          disabled={preferences.disabled}
          onCheckedChange={(hideDeprecated) =>
            void preferences.update((row) => ({ ...row, hideDeprecated }))
          }
        />
      </SettingRow>
      <SettingRow title="Only favourites" htmlFor="only-favourites" inline>
        <Switch
          id="only-favourites"
          checked={preferences.value?.showOnlyFavourites === true}
          disabled={preferences.disabled}
          onCheckedChange={(showOnlyFavourites) =>
            void preferences.update((row) => ({ ...row, showOnlyFavourites }))
          }
        />
      </SettingRow>
      <div className="flex min-h-9 items-center gap-2 text-ui">
        <span className="min-w-0 flex-1 text-muted-foreground">
          {catalog === undefined ? "Loading models…" : pluralCount(unique.length, "model")}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={refresh.pending || !!refresh.reason}
          onClick={() => refresh.refresh(props.provider)}
        >
          Refresh
        </Button>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide models" : "Show models"}
        </Button>
      </div>
      {open && (
        <ul aria-label="Models">
          {unique.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              starred={stars.favorites.includes(modelKey(model.provider, model.id))}
              toggleStar={() => stars.toggle(modelKey(model.provider, model.id))}
            />
          ))}
        </ul>
      )}
      <CustomModel provider={props.provider} />
    </>
  );
}
function ModelRow(props: { model: CatalogModel; starred: boolean; toggleStar(): void }) {
  const { model } = props;
  const preferences = useProviderConfiguration(model.provider);
  const hidden =
    preferences.value?.hiddenModels?.includes(model.id) === true ||
    model.visibilityReason === "model_hidden" ||
    model.visibilityReason === "deprecated" ||
    model.visibilityReason === "provider_hidden";
  return (
    <li className="flex min-h-9 items-center gap-2 text-ui">
      <span className="min-w-0 flex-1 truncate">{model.displayName}</span>
      {model.deprecated && <span className="text-xs text-muted-foreground">Deprecated</span>}
      {model.custom && <span className="text-xs text-muted-foreground">Custom</span>}
      <IconButton
        icon={StarIcon}
        label={`${props.starred ? "Unstar" : "Star"} ${model.displayName}`}
        pressed={props.starred}
        size="sm"
        disabled={preferences.disabled}
        onClick={props.toggleStar}
      />
      <IconButton
        icon={hidden ? EyeSlashIcon : EyeIcon}
        label={`${hidden ? "Show" : "Hide"} ${model.displayName}`}
        size="sm"
        disabled={preferences.disabled}
        onClick={() =>
          void preferences.update((row) => {
            const ids = new Set([model.id, ...(model.aliases ?? [])]);
            return {
              ...row,
              hiddenModels: hidden
                ? (row.hiddenModels ?? []).filter((id) => !ids.has(id))
                : [...new Set([...(row.hiddenModels ?? []), model.id])],
              shownModels: hidden
                ? [...new Set([...(row.shownModels ?? []), model.id])]
                : (row.shownModels ?? []).filter((id) => !ids.has(id)),
            };
          })
        }
      />
    </li>
  );
}
function CustomModel(props: { provider: ProviderKind }) {
  const preferences = useProviderConfiguration(props.provider);
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const valid =
    ProviderConfiguration.shape.customModels
      .unwrap()
      .element.safeParse({ id: id.trim(), displayName: name.trim() }).success &&
    !preferences.value?.customModels?.some((model) => model.id === id.trim());
  return open ? (
    <form
      className="grid gap-2 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        void preferences
          .update((row) => ({
            ...row,
            customModels: [
              ...(row.customModels ?? []),
              { id: id.trim(), displayName: name.trim() },
            ],
          }))
          .then((saved) => {
            if (!saved) return;
            setId("");
            setName("");
            setOpen(false);
          });
      }}
    >
      <label className="grid gap-1 text-sm">
        Model name used by the CLI
        <Input
          aria-label="Model name used by the CLI"
          placeholder="Model name used by the CLI"
          value={id}
          maxLength={256}
          onChange={(event) => setId(event.target.value)}
          autoFocus
        />
      </label>
      <label className="grid gap-1 text-sm">
        Display name
        <Input
          aria-label="Display name"
          placeholder="Display name"
          value={name}
          maxLength={256}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" type="submit" disabled={preferences.disabled || !valid}>
          Add model
        </Button>
      </div>
    </form>
  ) : (
    <Button
      size="sm"
      variant="ghost"
      className="mt-1"
      disabled={preferences.disabled}
      onClick={() => setOpen(true)}
    >
      Add custom model
    </Button>
  );
}

function DefaultModel(props: { provider: ProviderKind; models: readonly PickerModel[] }) {
  const preferences = useProviderConfiguration(props.provider);
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
  const choose = (id: string | null) => preferences.update((row) => ({ ...row, defaultModel: id }));
  return (
    <div className="flex min-h-9 items-center gap-2 py-1 text-ui">
      <span className="min-w-0 flex-1">Default model</span>
      <ModelField
        label="Default model"
        provider={props.provider}
        models={models}
        current={current?.key}
        value={current?.label ?? "None"}
        note={current?.userDefault ? "Your choice" : undefined}
        disabled={preferences.disabled}
        className="max-w-56"
        onPick={(key) => void choose(key.slice(key.indexOf("\u0000") + 1))}
      />
      {current?.userDefault && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5"
          disabled={preferences.disabled}
          onClick={() => void choose(null)}
        >
          Reset
        </Button>
      )}
    </div>
  );
}

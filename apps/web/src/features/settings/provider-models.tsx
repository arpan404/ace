import { pluralCount } from "@ace/ui-core";
import type { CatalogModel, ProviderKind } from "@ace/protocol";
import {
  customModelChange,
  providerDefaultModel,
  modelHidden,
  modelIdOfKey,
  modelVisibilityChange,
  modelKey,
  freeModelMarker,
  modelName,
  providerModelLists,
  providerModelProblems,
  type PickerModel,
} from "@ace/ui-core";
import { EyeIcon, EyeSlashIcon, StarIcon } from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { useState } from "react";
import { SettingList, SettingListItem, SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import {
  GroupProblem,
  ModelField,
  useFavoriteModels,
  useRefreshModels,
} from "@/features/model-picker/index.ts";
import { useModelCatalog, useModelInstances } from "@/lib/model-catalog.ts";
import { useProviderConfiguration } from "@/lib/provider-configuration.ts";
import { useAccountViews } from "@/features/accounts/index.ts";

export function ProviderModels(props: { provider: ProviderKind }) {
  const catalog = useModelCatalog();
  const preferences = useProviderConfiguration(props.provider);
  const instances = useModelInstances();
  const refresh = useRefreshModels();
  const stars = useFavoriteModels();
  const [open, setOpen] = useState(false);
  const rows = (catalog ?? []).filter((model) => model.provider === props.provider);
  const { unique, models, groups } = providerModelLists(rows, instances, props.provider);
  const byKey = new Map(unique.map((model) => [modelKey(model.provider, model.id), model]));
  // One line per problem: two accounts that can't reach the same service say it once.
  const accounts = useAccountViews();
  const accountsListed = !!accounts.data?.some((account) => account.provider === props.provider);
  const problems = providerModelProblems(groups, props.provider, accountsListed);
  return (
    <>
      {problems.length > 0 && (
        <SettingList aria-label="Model problems">
          {problems.map(({ problem, id }) => (
            <SettingListItem key={id} className="min-h-0">
              <GroupProblem
                id={id}
                provider={props.provider}
                problem={problem}
                className="flex-1 px-0"
              />
            </SettingListItem>
          ))}
        </SettingList>
      )}
      <DefaultModel
        provider={props.provider}
        models={models}
        catalog={catalog === undefined ? undefined : rows}
      />
      <SettingRow
        title="Models in the picker"
        description={
          catalog === undefined
            ? loadingModels("mt-1 h-3 w-44")
            : `${pluralCount(unique.filter((model) => !model.hidden).length, "model")} · legacy models in a submenu`
        }
        inline
      >
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          Manage
        </Button>
      </SettingRow>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Manage models</DialogTitle>
          </DialogHeader>
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
              {catalog === undefined
                ? loadingModels("h-3 w-20")
                : pluralCount(unique.length, "model")}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={refresh.pending || !!refresh.reason}
              onClick={() => refresh.refresh(props.provider)}
            >
              Refresh
            </Button>
          </div>
          {open && (
            <ul aria-label="Models">
              {groups.map((group) => (
                <li key={group.id}>
                  {group.label && (
                    <p className="py-1 text-xs text-muted-foreground">{group.label}</p>
                  )}
                  <ul aria-label={group.label ?? "Provider models"}>
                    {[...group.current, ...group.legacy].map((entry) => {
                      const model = byKey.get(entry.key);
                      return (
                        model && (
                          <ModelRow
                            key={entry.key}
                            model={model}
                            starred={stars.favorites.includes(entry.key)}
                            toggleStar={() => stars.toggle(entry.key)}
                          />
                        )
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          <CustomModel provider={props.provider} />
        </DialogContent>
      </Dialog>
    </>
  );
}
function ModelRow(props: { model: CatalogModel; starred: boolean; toggleStar(): void }) {
  const { model } = props;
  const label = modelName(model.provider, model.displayName, model.id);
  const preferences = useProviderConfiguration(model.provider);
  const hidden = modelHidden(preferences.value, model);
  return (
    <li className="flex min-h-9 items-center gap-2 text-ui">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {model.source?.label && (
        <span className="text-xs text-muted-foreground">{model.source.label}</span>
      )}
      {freeModelMarker({ free: model.free, label }) && (
        <span className="text-xs text-muted-foreground">Free</span>
      )}
      {model.deprecated && <span className="text-xs text-muted-foreground">Deprecated</span>}
      {model.custom && <span className="text-xs text-muted-foreground">Custom</span>}
      <IconButton
        icon={StarIcon}
        label={`${props.starred ? "Unstar" : "Star"} ${label}`}
        pressed={props.starred}
        size="sm"
        disabled={preferences.disabled}
        onClick={props.toggleStar}
      />
      <IconButton
        icon={hidden ? EyeSlashIcon : EyeIcon}
        label={`${hidden ? "Show" : "Hide"} ${label}`}
        size="sm"
        disabled={preferences.disabled}
        onClick={() => void preferences.update(modelVisibilityChange(model, hidden))}
      />
    </li>
  );
}
function CustomModel(props: { provider: ProviderKind }) {
  const preferences = useProviderConfiguration(props.provider);
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const edit = customModelChange(preferences.value, id, name);
  const valid = edit.ok;
  return open ? (
    <form
      className="grid gap-2 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!edit.ok) return;
        void preferences.update(edit.change).then((saved) => {
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

function DefaultModel(props: {
  provider: ProviderKind;
  models: readonly PickerModel[];
  catalog: readonly CatalogModel[] | undefined;
}) {
  const preferences = useProviderConfiguration(props.provider);
  const {
    choices: models,
    current,
    missing,
  } = providerDefaultModel(
    props.provider,
    props.models,
    props.catalog,
    preferences.value?.defaultModel,
  );
  if (!models.length) return null;
  const choose = (id: string | null) => preferences.update((row) => ({ ...row, defaultModel: id }));
  return (
    <SettingRow title="Default model" inline>
      <ModelField
        label="Default model"
        provider={props.provider}
        models={models}
        current={current?.key}
        value={current?.label ?? "None"}
        note={missing ? "Unavailable" : current?.userDefault ? "Your choice" : undefined}
        disabled={preferences.disabled}
        className="max-w-56"
        onPick={(key) => void choose(modelIdOfKey(key))}
      />
      {(current?.userDefault || missing) && (
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
    </SettingRow>
  );
}

/** A skeleton pill in a count's place while the catalog loads. */
function loadingModels(className: string) {
  return (
    <span role="status" aria-label="Loading models" className="block">
      <Skeleton className={className} />
    </span>
  );
}

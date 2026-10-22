import type { AccessMode, Automation } from "@ace/protocol";
import { accessChoices, newThreadAccess, providerNames } from "@ace/ui-core";
import { ModelPicker, resolveModelChoice } from "@/features/home/index.ts";
import { useNewThreadOptions } from "@/features/models/index.ts";
import { PermissionPicker, useAccessModes } from "@/features/thread/index.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useProjectMetadata } from "@/lib/projects.ts";
import { choicesFromModel, modelFromResolved } from "./automation-model.ts";

type ModelFields = Pick<Automation, "provider" | "model" | "effort" | "instance">;

function useModelResolution(fields: ModelFields) {
  const options = useNewThreadOptions();
  const choices = choicesFromModel(fields, options);
  const resolved = resolveModelChoice(options, choices, fields.provider, undefined);
  return { options, choices, resolved };
}

/** The model the chip shows for these fields, as it would be stored; undefined while loading. */
export function useShownModel(fields: ModelFields): ModelFields | undefined {
  return modelFromResolved(useModelResolution(fields).resolved);
}

/**
 * An automation's model in the composer's own model chip: model and effort on the chip; effort,
 * the account and the model picker in its popover. Every pick hands back the stored fields.
 * Automations run at the model's default speed, so a speed pick changes nothing.
 */
export function AutomationModelChip(props: {
  fields: ModelFields;
  onChange(fields: ModelFields): void;
}) {
  const { options, choices, resolved } = useModelResolution(props.fields);
  const pick = (next: typeof choices, provider = resolved.provider, keepEffort = true) => {
    const picked = modelFromResolved(resolveModelChoice(options, next, provider, undefined));
    if (!picked) return;
    props.onChange(keepEffort ? picked : { ...picked, effort: undefined });
  };
  return (
    <ModelPicker
      options={options}
      resolved={resolved}
      onModel={(key, listed) => {
        const rows = options?.models.filter((model) => model.key === key) ?? [];
        const under = options?.accounts.some((account) => account.id === listed);
        const stays = rows.some((model) => model.account === resolved.account?.id);
        pick(
          { model: key, account: under ? listed : stays ? resolved.account?.id : undefined },
          rows[0]?.provider,
          false,
        );
      }}
      onAccount={(account) => pick({ model: resolved.model?.key, account }, resolved.provider)}
      onEffort={(effort) =>
        pick(
          { model: resolved.model?.key, account: resolved.account?.id, effort },
          resolved.provider,
          effort !== undefined,
        )
      }
      onSpeed={() => undefined}
    />
  );
}

/**
 * How the automation's runs get approved, in the composer's access chip. Unset, it follows the
 * project's default, else this machine's; a mode the provider can't express runs as the nearest
 * stricter one.
 */
export function AutomationAccess(props: {
  fields: ModelFields & { workspace: string; access?: AccessMode | undefined };
  onChange(access: AccessMode): void;
}) {
  const { provider, instance, workspace, access } = props.fields;
  const projectDefaults = useProjectMetadata()(workspace)?.defaults;
  const [daemonDefault] = useDaemonSetting("access.defaultMode");
  const modes = useAccessModes(provider, undefined, instance);
  const shown = newThreadAccess({
    chosen: access,
    projectDefault: projectDefaults?.access,
    daemonDefault,
    offers: modes.offers,
    provider: providerNames[provider],
  });
  const loading = daemonDefault === undefined || modes.loading;
  return (
    <PermissionPicker
      summary={loading ? undefined : shown.summary}
      menu={{
        choices: accessChoices(modes.offers),
        value: shown.admitted,
        loading,
        unavailable: modes.failed
          ? "Couldn't load access modes. Reconnect and try again."
          : undefined,
      }}
      onChange={props.onChange}
    />
  );
}

import { ArrowsClockwiseIcon, TrashIcon } from "@phosphor-icons/react";
import { ProviderKind } from "@ace/protocol";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { CompactViewRowBody, compactViewRowClass } from "@/components/ui/view-row.tsx";
import { Screen } from "@/features/shell/index.ts";
import { useNow } from "@/lib/time.ts";
import { AgentsMenu } from "./agents-menu.tsx";
import { useInstallDialog } from "./install-plugin.tsx";
import { RemovePluginDialog } from "./remove-plugin.tsx";
import { AgentsLine, UseInThread } from "./skill-parts.tsx";
import { SkillSource } from "./skill-source.tsx";
import { kinds } from "./skills-sidebar.tsx";
import { pinText, sourceText, skillTitle, type Skill } from "./skills-model.ts";
import { useSetAvailability } from "./skills-source.ts";

/*
 * An ace plugin, or a skill, command, agent or rule it ships: on or off, which agents may load
 * it, its pin and its source.
 */

export function PluginSkillPage(props: {
  skill: Skill;
  plugin: Skill;
  components: readonly Skill[];
}) {
  const { skill, plugin, components } = props;
  const toast = useToast();
  const setAvailability = useSetAvailability();
  const install = useInstallDialog();
  const [removing, setRemoving] = useState(false);
  const isPlugin = skill.kind === "plugin";
  const ownSkill = skill.kind === "skill";
  const policy = ownSkill ? (skill.skillAvailability ?? skill) : plugin;
  const controlled = ownSkill ? skill : plugin;
  /** The page shows the change; only a failure needs saying. */
  const change = (next: { enabled?: boolean; providers?: readonly ProviderKind[] }) =>
    setAvailability.mutate(
      {
        plugin: plugin.plugin,
        skill: ownSkill ? skill.name : undefined,
        enabled: next.enabled ?? policy.enabled,
        providers: next.providers ?? policy.providers,
      },
      {
        onError: () =>
          toast.error({
            title: `Couldn't change ${skillTitle(controlled)}`,
            description: "Couldn't save the change. Check your connection and try again.",
          }),
      },
    );
  const setEnabled = (enabled: boolean) =>
    change({
      enabled,
      // Enabling an empty allowlist restores provider choices.
      ...(enabled && !policy.providers.length ? { providers: ProviderKind.options } : {}),
    });
  return (
    <Screen
      title="Skills"
      menu={
        <>
          {isPlugin && (
            <MenuItem
              icon={<Icon icon={ArrowsClockwiseIcon} />}
              onClick={() => install.update(plugin.plugin, plugin.install)}
            >
              Update…
            </MenuItem>
          )}
          <MenuItem danger icon={<Icon icon={TrashIcon} />} onClick={() => setRemoving(true)}>
            {isPlugin ? `Remove ${plugin.name}…` : `Remove plugin ${plugin.name}…`}
          </MenuItem>
        </>
      }
    >
      <RemovePluginDialog
        plugin={plugin.name}
        components={components}
        open={removing}
        onOpenChange={setRemoving}
      />
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-(--column) px-4 pt-6 pb-20 sm:px-8 sm:pt-11">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <h2 className="text-2xl font-semibold tracking-title">{skillTitle(skill)}</h2>
            </div>
            {(isPlugin || ownSkill) && (
              <LabelledSwitch
                label="Enabled"
                checked={policy.enabled}
                disabled={setAvailability.isPending}
                onCheckedChange={setEnabled}
              />
            )}
          </div>
          {skill.description && (
            <p className="mt-2 text-md text-muted-foreground">{skill.description}</p>
          )}
          {ownSkill && <UseInThread name={skill.name} />}
          <div className="mt-8">
            <SettingSection label={isPlugin ? "Plugin" : "Details"}>
              {!isPlugin && (
                <SettingRow
                  inline
                  title={
                    <Link
                      to="/skills/$skillId"
                      params={{ skillId: plugin.id }}
                      className="underline-offset-4 hover:underline"
                    >
                      Plugin: {skillTitle(plugin)}
                    </Link>
                  }
                  description={
                    !plugin.enabled
                      ? "This plugin is off. Turn it on to use its skills."
                      : undefined
                  }
                />
              )}
              {isPlugin && plugin.install && <VersionRow skill={plugin} />}
              {(isPlugin || ownSkill) && (
                <SettingRow
                  inline
                  title="Agents"
                  description={<AgentsLine providers={policy.providers} />}
                >
                  <AgentsMenu
                    agents={ProviderKind.options}
                    chosen={policy.providers}
                    onCommit={(providers) => change({ providers })}
                  />
                </SettingRow>
              )}
            </SettingSection>
            {isPlugin && components.length > 0 && <Contents components={components} />}
            {skill.path && <SkillSource key={skill.id} skill={skill} />}
          </div>
        </div>
      </div>
    </Screen>
  );
}

function LabelledSwitch(props: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange(checked: boolean): void;
}) {
  const id = useId();
  return (
    <span className="mt-2 flex shrink-0 items-center gap-2">
      <label htmlFor={id} className="text-ui text-muted-foreground">
        {props.label}
      </label>
      <Switch
        id={id}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onCheckedChange}
      />
    </span>
  );
}

function VersionRow(props: { skill: Skill }) {
  const now = useNow();
  const pin = props.skill.install;
  if (!pin) return null;
  return (
    <SettingRow
      title="Version"
      description={
        <>
          <span className="tabular-nums">{pinText(pin, now)}</span>
          {pin.repository && (
            <span className="block font-mono text-sm">
              From {sourceText(pin.repository, pin.ref)}
            </span>
          )}
        </>
      }
    />
  );
}

/** A plugin's page: everything it ships, by kind, each a link to its own page. */
function Contents(props: { components: readonly Skill[] }) {
  return (
    <SettingSection label="Contents">
      {kinds.map((group) => {
        const members = props.components.filter((skill) => skill.kind === group.kind);
        if (!members.length) return null;
        return (
          <ul key={group.kind} aria-label={group.label} className="flex flex-col gap-px">
            {members.map((skill) => (
              <li key={skill.id}>
                <Link
                  to="/skills/$skillId"
                  params={{ skillId: skill.id }}
                  className={compactViewRowClass}
                >
                  <CompactViewRowBody
                    icon={group.icon}
                    title={skillTitle(skill)}
                    status={skill.enabled ? undefined : <StatusLabel tone="idle" label="Off" />}
                  />
                </Link>
              </li>
            ))}
          </ul>
        );
      })}
    </SettingSection>
  );
}

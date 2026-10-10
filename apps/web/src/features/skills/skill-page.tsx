import { SkillSource } from "./skill-source.tsx";
import { ArrowsClockwiseIcon, CubeIcon, TrashIcon } from "@phosphor-icons/react";
import { ProviderKind } from "@ace/protocol";
import { providerNames } from "@ace/ui-core";
import { Link, Navigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useNow } from "@/lib/time.ts";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";

import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { CompactViewRowBody, compactViewRowClass } from "@/components/ui/view-row.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { Screen } from "@/features/shell/index.ts";
import { useInstallDialog } from "./install-plugin.tsx";
import { RemovePluginDialog } from "./remove-plugin.tsx";
import { SkillPageSkeleton } from "./skills-landing-screen.tsx";
import { kinds } from "./skills-sidebar.tsx";
import {
  availabilityText,
  componentsOf,
  pinText,
  pluginSkillId,
  sourceText,
  skillTitle,
  skillsLoadError,
  type Skill,
} from "./skills-model.ts";
import { useSetAvailability, useSkills } from "./skills-source.ts";

/** One skill, command, agent, rule or plugin: on or off, who may load it, and its source. */
export function SkillPage(props: { skillId: string }) {
  const skills = useSkills();
  const skill = skills.data?.find((entry) => entry.id === props.skillId);
  if (!skill && skills.data && props.skillId.startsWith("discovered~"))
    return <Navigate to="/skills" replace />;
  if (!skill)
    return (
      <Screen title="Skills">
        {skills.isError ? (
          <EmptyState
            icon={CubeIcon}
            heading
            title="Skills unavailable"
            description={skillsLoadError}
            action={
              <Button size="sm" onClick={() => void skills.refetch()}>
                Try again
              </Button>
            }
          />
        ) : skills.data && !skills.isFetching ? (
          <EmptyState
            icon={CubeIcon}
            heading
            title="This isn't installed"
            description="Its plugin may have been removed or updated without it."
            action={
              <Link to="/skills" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Back to Skills
              </Link>
            }
          />
        ) : (
          <SkillPageSkeleton />
        )}
      </Screen>
    );
  if (skill.discovered) return <DiscoveredSkillDetail skill={skill} />;
  const plugin = skills.data?.find((entry) => entry.id === pluginSkillId(skill.plugin));
  return (
    <SkillDetail
      skill={skill}
      plugin={plugin ?? skill}
      components={componentsOf(skills.data ?? [], skill.plugin)}
    />
  );
}

/** "engineering available to Claude Code and Codex", "… to every provider". */
function availabilityToast(plugin: string, providers: readonly ProviderKind[]): string {
  if (!providers.length) return `${plugin} hidden from every provider`;
  const text = availabilityText(providers);
  return `${plugin} available to ${text === "Every provider" ? "every provider" : text}`;
}

const sameProviders = (a: readonly ProviderKind[], b: readonly ProviderKind[]) =>
  a.length === b.length && a.every((provider) => b.includes(provider));

function SkillDetail(props: { skill: Skill; plugin: Skill; components: readonly Skill[] }) {
  const { skill, plugin, components } = props;
  const toast = useToast();
  const setAvailability = useSetAvailability();
  const install = useInstallDialog();
  const [removing, setRemoving] = useState(false);
  const isPlugin = skill.kind === "plugin";
  const ownSkill = skill.kind === "skill";
  const policy = ownSkill ? (skill.skillAvailability ?? skill) : plugin;
  const controlled = ownSkill ? skill : plugin;
  const change = (next: { enabled?: boolean; providers?: readonly ProviderKind[] }, done: string) =>
    setAvailability.mutate(
      {
        plugin: plugin.plugin,
        skill: ownSkill ? skill.name : undefined,
        enabled: next.enabled ?? policy.enabled,
        providers: next.providers ?? policy.providers,
      },
      {
        onSuccess: () => toast.add({ title: done }),
        onError: () =>
          toast.error({
            title: `Couldn't change ${skillTitle(controlled)}`,
            description: "Couldn't save the change. Check your connection and try again.",
          }),
      },
    );
  const setEnabled = (enabled: boolean) =>
    change(
      {
        enabled,
        // Enabling an empty allowlist restores provider choices.
        ...(enabled && !policy.providers.length ? { providers: ProviderKind.options } : {}),
      },
      `${skillTitle(controlled)} ${enabled ? "turned on" : "turned off"}`,
    );
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
            <p className="mt-2 truncate text-sm text-muted-foreground" title={skill.description}>
              {skill.description}
            </p>
          )}
          {ownSkill && (
            <div className="mt-4">
              <Link
                to="/new"
                search={{ skill: skill.name }}
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                Use in a thread
              </Link>
            </div>
          )}
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
                  !plugin.enabled ? "This plugin is off. Turn it on to use its skills." : undefined
                }
              />
            )}
            {isPlugin && plugin.install && <VersionRow skill={plugin} />}
            {(isPlugin || ownSkill) && (
              <SettingRow
                inline
                title="Available to"
                description={availabilityText(policy.providers)}
              >
                <AvailabilityMenu
                  providers={policy.providers}
                  onCommit={(providers) =>
                    change({ providers }, availabilityToast(skillTitle(controlled), providers))
                  }
                />
              </SettingRow>
            )}
          </SettingSection>
          {isPlugin && components.length > 0 && <Contents components={components} />}
          {skill.path && <SkillSource key={skill.id} skill={skill} />}
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

/**
 * "Change" beside Available to: ticks are a draft while the menu is open, and closing it sends
 * one change (and one toast), so quick ticks can't overwrite each other.
 */
function AvailabilityMenu(props: {
  providers: readonly ProviderKind[];
  onCommit(providers: readonly ProviderKind[]): void;
}) {
  const [draft, setDraft] = useState<readonly ProviderKind[]>();
  const shown = draft ?? props.providers;
  return (
    <Menu
      onOpenChange={(open) => {
        if (open) return setDraft(props.providers);
        if (draft && !sameProviders(draft, props.providers)) props.onCommit(draft);
        setDraft(undefined);
      }}
    >
      <MenuTrigger render={<Button variant="secondary" size="sm" />}>Change</MenuTrigger>
      <MenuContent align="end">
        {ProviderKind.options.map((provider) => (
          <MenuCheckboxItem
            key={provider}
            checked={shown.includes(provider)}
            onCheckedChange={(on) =>
              setDraft(
                on
                  ? ProviderKind.options.filter((p) => p === provider || shown.includes(p))
                  : shown.filter((p) => p !== provider),
              )
            }
          >
            {providerNames[provider]}
          </MenuCheckboxItem>
        ))}
      </MenuContent>
    </Menu>
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

function DiscoveredSkillDetail({ skill }: { skill: Skill }) {
  const source = skill.discovered?.source;
  return (
    <Screen title="Skills">
      <div className="mx-auto max-w-(--column) px-4 pt-6 sm:px-8 sm:pt-11">
        <h2 className="text-2xl font-semibold tracking-title">{skillTitle(skill)}</h2>
        <p className="mt-2 text-base text-muted-foreground">{skill.description}</p>
        <SettingSection label="Source">
          <p className="text-sm text-muted-foreground">
            {source?.provider === "ace" ? "ace" : source && providerNames[source.provider]} ·{" "}
            {source?.scope === "project" ? "This project" : "Provider catalog"}
          </p>
          {skill.path && <SettingRow title="Source file" description={skill.path} compact inline />}
        </SettingSection>
      </div>
    </Screen>
  );
}

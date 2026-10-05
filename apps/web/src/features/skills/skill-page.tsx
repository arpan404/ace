import { ArrowsClockwiseIcon, CubeIcon, TrashIcon } from "@phosphor-icons/react";
import { ProviderKind } from "@ace/protocol";
import { providerNames } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { daemonErrorCode, describeDaemonError } from "@/lib/daemon-command.ts";
import { useNow } from "@/lib/time.ts";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { SkeletonText } from "@/components/ui/skeleton.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { ViewRowBody, viewRowClass } from "@/components/ui/view-row.tsx";
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
  type Skill,
} from "./skills-model.ts";
import { useSetAvailability, useSkillSource, useSkills } from "./skills-source.ts";

/** One skill, command, agent, rule or plugin: on or off, who may load it, and its source. */
export function SkillPage(props: { skillId: string }) {
  const skills = useSkills();
  const skill = skills.data?.find((entry) => entry.id === props.skillId);
  if (!skill)
    return (
      <Screen title="Skills">
        {skills.isError ? (
          <EmptyState
            icon={CubeIcon}
            heading
            title="Skills unavailable"
            description={describeDaemonError(daemonErrorCode(skills.error))}
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
  const plugin = skills.data?.find((entry) => entry.id === pluginSkillId(skill.plugin));
  return (
    <SkillDetail
      skill={skill}
      plugin={plugin ?? skill}
      components={componentsOf(skills.data ?? [], skill.plugin)}
    />
  );
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "The plugin service didn't answer.";

/** "engineering available to Claude Code and Codex", "… to every provider". */
function availabilityToast(plugin: string, providers: readonly ProviderKind[]): string {
  if (!providers.length) return `${plugin} hidden from every provider`;
  const text = availabilityText(providers);
  return `${plugin} available to ${text === "Every provider" ? "every provider" : text}`;
}

const sameProviders = (a: readonly ProviderKind[], b: readonly ProviderKind[]) =>
  a.length === b.length && a.every((provider) => b.includes(provider));

/**
 * Availability is the plugin's: a component follows the plugin that ships it, so every control
 * on a component's page names the plugin it changes.
 */
function SkillDetail(props: { skill: Skill; plugin: Skill; components: readonly Skill[] }) {
  const { skill, plugin, components } = props;
  const toast = useToast();
  const setAvailability = useSetAvailability();
  const install = useInstallDialog();
  const [removing, setRemoving] = useState(false);
  const isPlugin = skill.kind === "plugin";
  const group = kinds.find((entry) => entry.kind === skill.kind)?.label ?? "Skills";
  // Shown at once; the catalog goes back with a toast if the daemon refuses.
  const change = (next: { enabled?: boolean; providers?: readonly ProviderKind[] }, done: string) =>
    setAvailability.mutate(
      {
        plugin: plugin.plugin,
        enabled: next.enabled ?? plugin.enabled,
        providers: next.providers ?? plugin.providers,
      },
      {
        onSuccess: () => toast.add({ title: done }),
        onError: (error) =>
          toast.error({ title: `Couldn't change ${plugin.name}`, description: errorText(error) }),
      },
    );
  const setEnabled = (enabled: boolean) =>
    change(
      {
        enabled,
        // Turning on a plugin no provider may load would leave it off.
        ...(enabled && !plugin.providers.length ? { providers: ProviderKind.options } : {}),
      },
      `${plugin.name} ${enabled ? "turned on" : "turned off"}`,
    );
  return (
    <Screen
      title={<span className="font-mono text-ui">{skill.name}</span>}
      subtitle={group}
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
        <div className="mx-auto max-w-(--column) px-8 pt-11 pb-20 max-sm:px-4 max-sm:pt-6">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <h2 className="font-mono text-xl font-semibold tracking-title">{skill.name}</h2>
              <p className="mt-1 text-base leading-normal text-muted-foreground">
                {skill.description}
              </p>
            </div>
            {isPlugin ? (
              <LabelledSwitch
                label="Enabled"
                checked={plugin.enabled}
                disabled={setAvailability.isPending}
                onCheckedChange={setEnabled}
              />
            ) : (
              <span className="mt-2 shrink-0 rounded-sm bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
                {skill.enabled ? "On" : `Off · ${plugin.name} is off`}
              </span>
            )}
          </div>
          <SettingSection label={isPlugin ? "Plugin" : "Details"} card>
            {!isPlugin && (
              <SettingRow
                title={
                  <Link
                    to="/skills/$skillId"
                    params={{ skillId: plugin.id }}
                    className="underline-offset-4 hover:underline"
                  >
                    {plugin.name} plugin
                  </Link>
                }
                description={`Ships with ${plugin.name}. Turning it off turns off everything it ships.`}
              >
                <Switch
                  aria-label={`Turn ${plugin.name} on or off`}
                  checked={plugin.enabled}
                  disabled={setAvailability.isPending}
                  onCheckedChange={setEnabled}
                />
              </SettingRow>
            )}
            {isPlugin && plugin.install && <VersionRow skill={plugin} />}
            {skill.path && (
              <SettingRow
                title="Source"
                description={<span className="font-mono text-sm">{skill.path}</span>}
              />
            )}
            <SettingRow title="Available to" description={availabilityText(plugin.providers)}>
              <AvailabilityMenu
                providers={plugin.providers}
                onCommit={(providers) =>
                  change(
                    // Choosing providers for an off plugin doesn't turn it on.
                    { providers },
                    availabilityToast(plugin.name, providers),
                  )
                }
              />
            </SettingRow>
          </SettingSection>
          {isPlugin && components.length > 0 && <Contents components={components} />}
          {skill.path && <SourcePreview skill={skill} />}
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
      description={<span className="tabular-nums">{pinText(pin, now)}</span>}
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
      <MenuTrigger render={<Button variant="ghost" size="sm" />}>Change</MenuTrigger>
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
                <Link to="/skills/$skillId" params={{ skillId: skill.id }} className={viewRowClass}>
                  <ViewRowBody
                    icon={group.icon}
                    title={skill.name}
                    description={skill.description}
                    mono={skill.kind === "skill" || skill.kind === "command"}
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

function SourcePreview(props: { skill: Skill }) {
  const source = useSkillSource(props.skill);
  return (
    <SettingSection label="Preview">
      {source.isError ? (
        <p className="text-ui text-muted-foreground">{errorText(source.error)}</p>
      ) : source.data === undefined ? (
        <SkeletonText lines={4} />
      ) : (
        <pre className="rounded-lg bg-code px-4 py-3.5 font-mono text-sm leading-[1.6] whitespace-pre-wrap">
          {source.data.text}
          {source.data.truncated && "\n…"}
        </pre>
      )}
    </SettingSection>
  );
}

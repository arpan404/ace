import { CubeIcon, TrashIcon } from "@phosphor-icons/react";
import { ProviderKind } from "@ace/protocol";
import { providerNames } from "@ace/ui-core";
import { Link, useNavigate } from "@tanstack/react-router";
import { Icon } from "@/components/icon.tsx";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
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
import { Screen } from "@/features/shell/index.ts";
import { kinds } from "./skills-sidebar.tsx";
import { availabilityText, pluginSkillId, type Skill } from "./skills-model.ts";
import { useRemovePlugin, useSetAvailability, useSkillSource, useSkills } from "./skills-source.ts";

/** One skill, command, agent, rule or plugin: on or off, who may load it, and its source. */
export function SkillPage(props: { skillId: string }) {
  const skills = useSkills();
  const skill = skills.data?.find((entry) => entry.id === props.skillId);
  if (!skill)
    return (
      <Screen title="Skills">
        {(skills.isError || (skills.data && !skills.isFetching)) && (
          <EmptyState
            icon={CubeIcon}
            heading
            title={skills.isError ? "Skills unavailable" : "This isn't installed"}
            description={
              skills.isError
                ? skills.error.message
                : "Its plugin may have been removed or updated without it."
            }
          />
        )}
      </Screen>
    );
  const plugin = skills.data?.find((entry) => entry.id === pluginSkillId(skill.plugin));
  return <SkillDetail skill={skill} plugin={plugin ?? skill} />;
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "The plugin service didn't answer.";

/** Availability is the plugin's: a component follows the plugin that ships it. */
function SkillDetail(props: { skill: Skill; plugin: Skill }) {
  const { skill, plugin } = props;
  const toast = useToast();
  const navigate = useNavigate();
  const setAvailability = useSetAvailability();
  const remove = useRemovePlugin();
  const isPlugin = skill.kind === "plugin";
  const group = kinds.find((entry) => entry.kind === skill.kind)?.label ?? "Skills";
  const change = (next: { enabled?: boolean; providers?: readonly ProviderKind[] }, done: string) =>
    setAvailability.mutate(
      {
        plugin: plugin.plugin,
        enabled: next.enabled ?? plugin.enabled,
        providers: next.providers ?? plugin.providers,
      },
      {
        onSuccess: () => toast.add({ title: done }),
        onError: (error) => toast.add({ title: errorText(error) }),
      },
    );
  const toggleProvider = (provider: ProviderKind, on: boolean) =>
    change(
      {
        providers: on
          ? ProviderKind.options.filter((p) => p === provider || plugin.providers.includes(p))
          : plugin.providers.filter((p) => p !== provider),
      },
      `${plugin.name} ${on ? "available to" : "hidden from"} ${providerNames[provider]}`,
    );
  return (
    <Screen
      title={<span className="font-mono text-[13.5px]">{skill.name}</span>}
      subtitle={group}
      menu={
        <MenuItem
          danger
          icon={<Icon icon={TrashIcon} size={14} />}
          onClick={() =>
            remove.mutate(plugin.plugin, {
              onSuccess: () => {
                toast.add({ title: `Removed ${plugin.name}` });
                void navigate({ to: "/skills" });
              },
              onError: (error) => toast.add({ title: errorText(error) }),
            })
          }
        >
          Remove {plugin.name}
        </MenuItem>
      }
    >
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-[760px] px-8 pt-11 pb-20">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <h2 className="font-mono text-xl font-semibold tracking-title">{skill.name}</h2>
              <p className="mt-1 text-base leading-normal text-muted-foreground">
                {skill.description}
              </p>
            </div>
            <Switch
              aria-label="Enabled"
              checked={plugin.enabled}
              disabled={setAvailability.isPending}
              className="mt-2.5"
              onCheckedChange={(enabled) =>
                change(
                  {
                    enabled,
                    // Turning on a plugin no provider may load would leave it off.
                    ...(enabled && !plugin.providers.length
                      ? { providers: ProviderKind.options }
                      : {}),
                  },
                  `${plugin.name} ${enabled ? "enabled" : "turned off"}`,
                )
              }
            />
          </div>
          <div className="mt-7">
            {!isPlugin && (
              <SettingRow
                title="Plugin"
                description={
                  skill.enabled
                    ? `Ships with ${plugin.name}; turning it off turns off the whole plugin.`
                    : `Ships with ${plugin.name}, which is off.`
                }
              >
                <Link
                  to="/skills/$skillId"
                  params={{ skillId: plugin.id }}
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                >
                  Open plugin
                </Link>
              </SettingRow>
            )}
            {skill.path && (
              <SettingRow
                title="Source"
                description={<span className="font-mono text-sm">{skill.path}</span>}
              />
            )}
            <SettingRow title="Available to" description={availabilityText(plugin.providers)}>
              <Menu>
                <MenuTrigger render={<Button variant="ghost" size="sm" />}>Change</MenuTrigger>
                <MenuContent align="end">
                  {ProviderKind.options.map((provider) => (
                    <MenuCheckboxItem
                      key={provider}
                      checked={plugin.providers.includes(provider)}
                      onCheckedChange={(on) => toggleProvider(provider, on)}
                    >
                      {providerNames[provider]}
                    </MenuCheckboxItem>
                  ))}
                </MenuContent>
              </Menu>
            </SettingRow>
          </div>
          {skill.path && <SourcePreview skill={skill} />}
        </div>
      </div>
    </Screen>
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

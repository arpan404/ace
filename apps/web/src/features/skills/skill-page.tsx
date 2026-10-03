import { CodeIcon, CubeIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Screen } from "@/features/shell/index.ts";
import { kinds } from "./skills-sidebar.tsx";
import {
  availabilities,
  useSetAvailability,
  useSetSkillEnabled,
  useSkills,
  type Skill,
} from "./skills-source.ts";

/** One skill, plugin or slash command: enabled, where it comes from, who may use it, preview. */
export function SkillPage(props: { skillId: string }) {
  const skills = useSkills();
  const skill = skills.data?.find((entry) => entry.id === props.skillId);
  if (!skill)
    return (
      <Screen title="Skills">
        {(skills.isError || skills.data) && (
          <EmptyState
            icon={CubeIcon}
            heading
            title={skills.isError ? "Skills unavailable" : "This skill isn't installed"}
            description={
              skills.isError
                ? skills.error.message
                : "It may have been removed from the repo or your home folder."
            }
          />
        )}
      </Screen>
    );
  return <SkillDetail skill={skill} />;
}

function SkillDetail(props: { skill: Skill }) {
  const { skill } = props;
  const toast = useToast();
  const setEnabled = useSetSkillEnabled();
  const setAvailability = useSetAvailability();
  const group = kinds.find((entry) => entry.kind === skill.kind)?.label ?? "Skills";
  // TODO(train-2): open in the user's editor through the daemon once it can.
  const openSource = () => toast.add({ title: `Opening ${skill.location}` });
  return (
    <Screen
      title={<span className="font-mono text-[13.5px]">{skill.name}</span>}
      subtitle={group}
      actions={
        <Button variant="ghost" size="sm" onClick={openSource}>
          <Icon icon={CodeIcon} size={14} />
          Edit source
        </Button>
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
              checked={skill.enabled}
              className="mt-2.5"
              onCheckedChange={(enabled) =>
                setEnabled.mutate(
                  { id: skill.id, enabled },
                  {
                    onSuccess: () =>
                      toast.add({ title: `${skill.name} ${enabled ? "enabled" : "turned off"}` }),
                  },
                )
              }
            />
          </div>
          <div className="mt-7">
            <SettingRow title="Source" description={skill.location}>
              <Button variant="ghost" size="sm" onClick={openSource}>
                Reveal
              </Button>
            </SettingRow>
            <SettingRow title="Usage" description={skill.usage} />
            <SettingRow title="Available to" description={skill.availability}>
              <Menu>
                <MenuTrigger render={<Button variant="ghost" size="sm" />}>Change</MenuTrigger>
                <MenuContent align="end">
                  <MenuRadioGroup
                    value={skill.availability}
                    onValueChange={(value: unknown) => {
                      const picked = availabilities.find((entry) => entry === value);
                      if (picked) setAvailability.mutate({ id: skill.id, availability: picked });
                    }}
                  >
                    {availabilities.map((entry) => (
                      <MenuRadioItem key={entry} value={entry}>
                        {entry.split(".")[0]}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuContent>
              </Menu>
            </SettingRow>
          </div>
          <SettingSection label="Preview">
            <pre className="rounded-lg bg-code px-4 py-3.5 font-mono text-sm leading-[1.6] whitespace-pre-wrap">
              {skill.preview}
            </pre>
          </SettingSection>
        </div>
      </div>
    </Screen>
  );
}

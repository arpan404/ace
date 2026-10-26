import { CubeIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/index.ts";
import { LibrarySkillPage } from "./library-skill-page.tsx";
import { PluginSkillPage } from "./plugin-skill-page.tsx";
import { SkillPageSkeleton } from "./skills-landing-screen.tsx";
import { componentsOf, pluginSkillId, skillsLoadError } from "./skills-model.ts";
import { useSkills } from "./skills-source.ts";

/** One entry of the library: a skill from the agents' folders, or an ace plugin's. */
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
            title="This skill isn't here anymore"
            description="It may have been deleted, or its plugin removed."
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
  if (skill.library) return <LibrarySkillPage key={skill.library.id} entry={skill.library} />;
  const plugin = skills.data?.find((entry) => entry.id === pluginSkillId(skill.plugin));
  return (
    <PluginSkillPage
      skill={skill}
      plugin={plugin ?? skill}
      components={componentsOf(skills.data ?? [], skill.plugin)}
    />
  );
}

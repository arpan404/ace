import { repositoryLabel, reviewRepositories } from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { useProjectDialogsIfHosted } from "@/features/projects/index.ts";
import { useProjectRepositoryLists } from "@/lib/project-repositories.ts";
import { useProjectDirectory } from "@/lib/projects.ts";
import { settingRow } from "./settings-index.ts";

/**
 * Settings › Source control › Project repositories: each project's repositories in a line, and
 * Edit, which opens the project's own settings where they are chosen (ADR 0120). The hosts above
 * are global; which repositories a project uses is the project's.
 */
export function SourceControlProjects() {
  const dialogs = useProjectDialogsIfHosted();
  const projects = useProjectDirectory().projects.filter((project) => project.kind !== "chat");
  const { lists, failed } = useProjectRepositoryLists(projects.map((project) => project.id));
  if (!dialogs) return null;
  return (
    <SettingSection
      label="Project repositories"
      anchor={settingRow("sourceControl.projectRepositories").id}
    >
      {projects.map((project) => {
        const value = lists.get(project.id);
        const used = value ? reviewRepositories(value) : [];
        const description = failed.has(project.id)
          ? "Couldn't read its repositories"
          : !value
            ? undefined
            : used.length === 0
              ? "Not linked"
              : used.length === 1 && used[0]
                ? repositoryLabel(used[0])
                : `${used.length} repositories${value.primary ? ` · Primary ${repositoryLabel(value.primary)}` : ""}`;
        return (
          <SettingRow key={project.id} title={project.name} description={description} inline>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Edit ${project.name}'s repositories`}
              onClick={() => dialogs.open({ kind: "edit", projectId: project.id })}
            >
              Edit
            </Button>
          </SettingRow>
        );
      })}
      {!projects.length && <SettingNote>Add a project to choose its repositories.</SettingNote>}
    </SettingSection>
  );
}

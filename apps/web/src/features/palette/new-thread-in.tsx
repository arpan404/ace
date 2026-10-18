import { FolderSimpleIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { CommandChoices, type CommandChoice } from "@/components/ui/command-choices.tsx";
import { focusComposerSoon } from "@/lib/focus-composer.ts";
import { useProjectDirectory } from "@/lib/projects.ts";

/** "New thread in…": the projects by name; choosing one opens a new thread draft there. */
export function NewThreadIn(props: { onBack: () => void; close(): void }) {
  const navigate = useNavigate();
  const directory = useProjectDirectory();
  const choices = useMemo(
    () =>
      directory.projects.map((project): CommandChoice => ({
        id: project.id,
        label: project.name,
        icon: FolderSimpleIcon,
      })),
    [directory.projects],
  );
  return (
    <CommandChoices
      fieldLabel="Search projects"
      listLabel="Projects"
      placeholder="New thread in…"
      choices={choices}
      onChoose={(choice) => {
        props.close();
        void navigate({ to: "/new", search: { project: choice.id } });
        focusComposerSoon();
      }}
      onBack={props.onBack}
      empty="No projects match"
    />
  );
}

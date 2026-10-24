import { ChatCircleIcon, FolderPlusIcon, FolderSimpleIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { CommandChoices, type CommandChoice } from "@/components/ui/command-choices.tsx";
import { focusComposerSoon } from "@/lib/focus-composer.ts";
import { useProjectDirectory } from "@/lib/projects.ts";
import { chatChoice } from "@/lib/chat-choice.ts";

/** The last row: add a project here, whose new thread draft then opens. */
const addProject = "\u0000add-project";

/**
 * "New thread in…": the projects by name, then a chat with no project, then Add project…;
 * choosing a project or the chat opens a new thread draft there.
 */
export function NewThreadIn(props: { onBack: () => void; close(): void; onAddProject(): void }) {
  const navigate = useNavigate();
  const directory = useProjectDirectory();
  const choices = useMemo(
    () => [
      ...directory.projects.map((project): CommandChoice => ({
        id: project.id,
        label: project.name,
        icon: FolderSimpleIcon,
      })),
      { id: chatChoice, label: "No project", icon: ChatCircleIcon },
      { id: addProject, label: "Add project…", icon: FolderPlusIcon },
    ],
    [directory.projects],
  );
  return (
    <CommandChoices
      fieldLabel="Search projects"
      listLabel="Projects"
      placeholder="New thread in…"
      choices={choices}
      onChoose={(choice) => {
        if (choice.id === addProject) return props.onAddProject();
        props.close();
        void navigate({ to: "/new", search: { project: choice.id } });
        focusComposerSoon();
      }}
      onBack={props.onBack}
      empty="No projects match"
    />
  );
}

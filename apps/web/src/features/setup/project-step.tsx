import { ChatCircleIcon, FolderSimpleIcon } from "@ace/icons";
import { displayPath } from "@ace/ui-core";
import { ChoiceList, ChoiceRow } from "@/components/choice-row.tsx";
import {
  projectSources,
  useHostHome,
  useProjectDialogs,
  type AddPage,
  type AddTab,
} from "@/features/projects/index.ts";
import { usePrimaryMachine } from "@/lib/machines.ts";
import { useProjectDirectory } from "@/lib/projects.ts";

/** The Add project tab each source opens on. */
const tabs: Record<AddPage, AddTab> = {
  "add-project": "sources",
  "add-local": "open",
  "add-create": "create",
  "add-clone": "clone",
  "add-github": "github",
};

/** What each source gives you, in a few words. */
const hints: Partial<Record<AddPage, string>> = {
  "add-local": "A folder already on this computer",
  "add-create": "An empty folder ace makes for you",
  "add-clone": "Clone any repository by its URL",
  "add-github": "Clone one of your repositories",
};

/**
 * The first project: its four sources open Add project straight on that source (adding one
 * comes back to Done), a project the person already has goes straight on, and a chat needs
 * none.
 */
export function ProjectStep(props: { onPicked(projectId: string): void; onChat(): void }) {
  const projects = useProjectDialogs();
  const directory = useProjectDirectory();
  const home = useHostHome(usePrimaryMachine()).data?.path;
  const known = directory.projects.length > 0;
  return (
    <div className="flex flex-col gap-6">
      {known && (
        <ChoiceList label="Your projects" heading="Your projects">
          {directory.projects.slice(0, 5).map((project) => (
            <ChoiceRow
              key={project.id}
              icon={FolderSimpleIcon}
              label={project.name}
              hint={<span className="font-mono">{displayPath(project.path, home)}</span>}
              onClick={() => props.onPicked(project.id)}
            />
          ))}
        </ChoiceList>
      )}
      <ChoiceList label="Add a project" {...(known ? { heading: "Add another" } : {})}>
        {projectSources.map((source) => (
          <ChoiceRow
            key={source.page}
            icon={source.icon}
            label={source.label}
            hint={hints[source.page]}
            onClick={() => projects.open({ kind: "add", tab: tabs[source.page] })}
            onPointerEnter={projects.preload}
          />
        ))}
        <ChoiceRow
          icon={ChatCircleIcon}
          label="Start a chat"
          hint="No folder, just a conversation"
          onClick={props.onChat}
        />
      </ChoiceList>
    </div>
  );
}

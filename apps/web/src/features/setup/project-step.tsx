import { CaretRightIcon, ChatCircleIcon, FolderOpenIcon, FolderSimpleIcon } from "@ace/icons";
import { displayPath } from "@ace/ui-core";
import type { ReactNode } from "react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import {
  projectSources,
  useHostHome,
  useProjectDialogs,
  type AddPage,
  type AddTab,
} from "@/features/projects/index.ts";
import { usePrimaryMachine } from "@/lib/machines.ts";
import { useProjectDirectory } from "@/lib/projects.ts";
import { part } from "@/lib/suit-part.ts";
import { StepHeader } from "./step-header.tsx";

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
 * comes back here, to Done), a project the person already has goes straight on, and a chat
 * needs none.
 */
export function ProjectStep(props: { onPicked(projectId: string): void; onChat(): void }) {
  const projects = useProjectDialogs();
  const directory = useProjectDirectory();
  const home = useHostHome(usePrimaryMachine()).data?.path;
  return (
    <>
      <StepHeader
        mark={<FolderOpenIcon aria-hidden size={36} />}
        title="Add your first project"
        lede="A folder your agents work in."
      />
      <div className="flex w-full flex-col gap-6">
        {directory.projects.length > 0 && (
          <section aria-label="Your projects" className="flex flex-col gap-1">
            <h3 className="text-sm font-medium text-muted-foreground">Your projects</h3>
            <ul {...part("list", undefined, "projects")} className="flex flex-col">
              {directory.projects.slice(0, 5).map((project) => (
                <ChoiceRow
                  key={project.id}
                  icon={FolderSimpleIcon}
                  label={project.name}
                  hint={<span className="font-mono">{displayPath(project.path, home)}</span>}
                  onClick={() => props.onPicked(project.id)}
                />
              ))}
            </ul>
          </section>
        )}
        <section aria-label="Add a project" className="flex flex-col gap-1">
          {directory.projects.length > 0 && (
            <h3 className="text-sm font-medium text-muted-foreground">Add another</h3>
          )}
          <ul {...part("list", undefined, "project-sources")} className="flex flex-col">
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
          </ul>
        </section>
        <ul aria-label="Without a project" className="flex flex-col">
          <ChoiceRow
            icon={ChatCircleIcon}
            label="Start a chat"
            hint="No folder, just a conversation"
            onClick={props.onChat}
          />
        </ul>
      </div>
    </>
  );
}

/** One choice: the whole row is the button. */
function ChoiceRow(props: {
  icon: IconGlyph;
  label: string;
  hint?: ReactNode;
  onClick(): void;
  onPointerEnter?: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        {...part("list-row", undefined, "choice")}
        className="group -mx-2 flex min-h-12 w-[calc(100%+1rem)] min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-(--motion-fast) hover:bg-hover focus-ring-inset"
        onClick={props.onClick}
        onPointerEnter={props.onPointerEnter}
      >
        <Icon icon={props.icon} size={16} className="shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{props.label}</span>
          {props.hint && (
            <span className="truncate text-sm text-muted-foreground">{props.hint}</span>
          )}
        </span>
        <Icon
          icon={CaretRightIcon}
          size={14}
          className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </button>
    </li>
  );
}

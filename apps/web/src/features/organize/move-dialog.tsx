import { ProjectImage } from "@/components/project-image.tsx";
import { FolderSimpleIcon } from "@phosphor-icons/react";
import { projectTint } from "@ace/ui-core";
import { useMemo } from "react";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.tsx";
import { useProjectDirectory } from "@/lib/projects.ts";
import type { MoveRequest } from "./mover.ts";
import { useThreadActions } from "./use-thread-actions.ts";

interface Choice {
  icon?: string | null;
  id: string;
  name: string;
  path: string;
}

/**
 * Which project the threads move to: the daemon's projects by name, without the one they are
 * all in already, found by typing and picked with the arrows and Enter. Picking moves them at
 * once (`moveMany`), with Undo; the daemon's refusal puts them back with its reason.
 */
export function MoveDialog(props: { request: MoveRequest; open: boolean; onClose(): void }) {
  const { entries, onMoved } = props.request;
  const directory = useProjectDirectory();
  const actions = useThreadActions();
  const from = entries.every((entry) => entry.workspaceId === entries[0]?.workspaceId)
    ? entries[0]?.workspaceId
    : undefined;
  const groups = useMemo(() => {
    const items = directory.projects.flatMap((project): Choice[] =>
      project.id === from
        ? []
        : [
            {
              id: project.id,
              name: directory.name(project.id),
              path: project.path,
              icon: project.icon ?? project.defaultIcon ?? null,
            },
          ],
    );
    return [{ value: "Projects", items }];
  }, [directory, from]);
  const first = entries[0];
  const what = entries.length === 1 && first ? `“${first.title}”` : `${entries.length} threads`;
  const pick = (choice: Choice) => {
    props.onClose();
    actions.moveMany(entries, { id: choice.id, name: choice.name });
    onMoved?.();
  };
  const none = groups[0]?.items.length === 0;
  return (
    <CommandDialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      title="Move to project"
    >
      <Command items={groups} itemToStringValue={(item: Choice) => item.name}>
        <CommandInput
          aria-label="Search projects"
          placeholder={`Move ${what} to…`}
          closeLabel="Close"
        />
        <CommandEmpty>
          {!directory.loaded
            ? "Reading the projects…"
            : none
              ? "There is no other project. Add one first."
              : "No projects match."}
        </CommandEmpty>
        <CommandList>
          {(group: { value: string; items: Choice[] }) => (
            <CommandGroup key={group.value} items={group.items}>
              <CommandGroupLabel>Projects</CommandGroupLabel>
              <CommandCollection>
                {(choice: Choice) => (
                  <CommandItem key={choice.id} value={choice} onClick={() => pick(choice)}>
                    <ProjectImage
                      icon={choice.icon}
                      fallback={
                        <FolderSimpleIcon
                          aria-hidden
                          style={{ color: `var(--project-${projectTint(choice.id)})` }}
                        />
                      }
                    />
                    <span className="shrink-0 truncate">{choice.name}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">
                      {choice.path}
                    </span>
                  </CommandItem>
                )}
              </CommandCollection>
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

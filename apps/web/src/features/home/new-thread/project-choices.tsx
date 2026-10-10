import { useState } from "react";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { CheckIcon, FolderPlusIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useConnectionState } from "@ace/client-react";
import { projectBadge } from "@ace/ui-core";
import { ProjectMark } from "../row-parts.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Command,
  CommandCollection,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  commandField,
} from "@/components/ui/command.tsx";
import { useProjectDialogs } from "@/features/projects/index.ts";
export interface Choice {
  id: string;
  name: string;
  path: string;
  icon: string | null | undefined;
}

export function ProjectChoices(props: {
  choices: Choice[];
  project: string | undefined;
  onProject(project: string): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const dialogs = useProjectDialogs();
  const reachable = useConnectionState() === "ready";
  const { choices } = props;
  const matches = choices.filter((choice) =>
    `${choice.name}\n${choice.path}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <>
      <Command
        items={[{ value: "Projects", items: matches }]}
        filter={null}
        itemToStringValue={(choice: Choice) => choice.name}
        value={query}
        onValueChange={setQuery}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <MagnifyingGlassIcon aria-hidden size={16} className="shrink-0 text-muted-foreground" />
          <Autocomplete.Input
            autoFocus
            aria-label="Search projects"
            placeholder="Search projects…"
            className={commandField}
          />
        </div>
        <CommandEmpty>{choices.length ? "No projects match." : "No projects yet."}</CommandEmpty>
        <CommandList className="max-h-[min(280px,40dvh)] p-1.5">
          {(group: { value: string; items: Choice[] }) => (
            <CommandGroup items={group.items}>
              <CommandCollection>
                {(choice: Choice) => (
                  <CommandItem
                    key={choice.id}
                    value={choice}
                    aria-label={choice.name}
                    aria-selected={choice.id === props.project}
                    onClick={() => {
                      props.onProject(choice.id);
                      props.onClose();
                    }}
                    className="h-auto min-h-9 text-ui"
                  >
                    <ProjectMark badge={projectBadge(choice)} icon={choice.icon} />
                    <span className="min-w-0 flex-1 truncate">{choice.name}</span>
                    {choice.id === props.project && <CheckIcon aria-hidden size={14} />}
                  </CommandItem>
                )}
              </CommandCollection>
            </CommandGroup>
          )}
        </CommandList>
      </Command>
      <div className="shrink-0 border-t p-1.5">
        <Button
          variant="ghost"
          className="w-full justify-start"
          disabled={!reachable}
          aria-label="Add project"
          onPointerEnter={dialogs.preload}
          onClick={() => {
            props.onClose();
            dialogs.open({ kind: "add", tab: "sources" });
          }}
        >
          <FolderPlusIcon aria-hidden size={16} />
          Add project…
        </Button>
      </div>
    </>
  );
}

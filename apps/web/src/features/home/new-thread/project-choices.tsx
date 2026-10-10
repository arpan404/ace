import { Autocomplete } from "@base-ui/react/autocomplete";
import { CheckIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { projectBadge } from "@ace/ui-core";
import { ProjectMark } from "../row-parts.tsx";
import {
  Command,
  CommandCollection,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  commandField,
} from "@/components/ui/command.tsx";

export interface ProjectChoice {
  id: string;
  name: string;
  path: string;
  icon: string | null | undefined;
}

/** The project picker's search and list, inside its popup. */
export function ProjectChoices(props: {
  choices: readonly ProjectChoice[];
  project: string | undefined;
  query: string;
  onQuery(query: string): void;
  onPick(project: string): void;
}) {
  const needle = props.query.trim().toLocaleLowerCase();
  const matches = props.choices.filter((choice) =>
    `${choice.name}\n${choice.path}`.toLocaleLowerCase().includes(needle),
  );
  return (
    <Command
      items={[{ value: "Projects", items: matches }]}
      filter={null}
      itemToStringValue={(choice: ProjectChoice) => choice.name}
      value={props.query}
      onValueChange={props.onQuery}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <MagnifyingGlassIcon aria-hidden size={16} className="shrink-0 text-muted-foreground" />
        <Autocomplete.Input
          // The popup may open before this list's code arrives and focus Add project meanwhile.
          autoFocus
          aria-label="Search projects"
          placeholder="Search projects…"
          className={commandField}
        />
      </div>
      <CommandEmpty>
        {props.choices.length ? "No projects match." : "No projects yet."}
      </CommandEmpty>
      <CommandList className="max-h-[min(280px,40dvh)] p-1.5">
        {(group: { value: string; items: ProjectChoice[] }) => (
          <CommandGroup items={group.items}>
            <CommandCollection>
              {(choice: ProjectChoice) => (
                <CommandItem
                  key={choice.id}
                  value={choice}
                  aria-label={choice.name}
                  aria-selected={choice.id === props.project}
                  onClick={() => props.onPick(choice.id)}
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
  );
}

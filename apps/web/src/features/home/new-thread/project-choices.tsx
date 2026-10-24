import { useState } from "react";
import { Autocomplete } from "@base-ui/react/autocomplete";
import {
  ChatCircleIcon,
  CheckIcon,
  FolderPlusIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { useConnectionState } from "@ace/client-react";
import { displayPath, projectBadge, type NewFolder } from "@ace/ui-core";
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
import { useToast } from "@/components/ui/toast.tsx";
import {
  projectFailure,
  useNewProjectFolder,
  useProjectDialogs,
} from "@/features/projects/index.ts";
import { chatChoice } from "./chat-project.ts";
export interface Choice {
  id: string;
  name: string;
  path: string;
}

/** A project to pick, a chat with no project, or the typed folder to create and add. */
type Item = Choice | { chat: true } | { create: NewFolder };

const chatLabel = "Chat";

export function ProjectChoices(props: {
  choices: Choice[];
  project: string | undefined;
  onProject(project: string): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const dialogs = useProjectDialogs();
  const toast = useToast();
  const reachable = useConnectionState() === "ready";
  const typed = useNewProjectFolder(query);
  const { choices } = props;
  const matches = choices.filter((choice) =>
    `${choice.name}\n${choice.path}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  // The typed folder doesn't exist yet: the list ends with creating it, the default when
  // no project matches.
  const folder = typed.folder;
  const create =
    folder &&
    reachable &&
    !choices.some(
      (choice) =>
        choice.path === folder.path || choice.name.toLowerCase() === folder.name.toLowerCase(),
    )
      ? folder
      : undefined;
  const search = query.trim().toLocaleLowerCase();
  const chat = !search || `${chatLabel}\nno project`.toLocaleLowerCase().includes(search);
  const groups: { value: string; items: Item[] }[] = [
    ...(chat ? [{ value: "Chat", items: [{ chat: true as const }] }] : []),
    { value: "Projects", items: matches },
    ...(create ? [{ value: "Create", items: [{ create }] }] : []),
  ];
  const make = (target: NewFolder) => {
    if (creating) return;
    setCreating(true);
    typed.create(target.path).then(
      (added) => {
        props.onProject(added.project.id);
        props.onClose();
      },
      (error: unknown) => {
        setCreating(false);
        toast.error({
          title: `Couldn't create ${target.name}`,
          description: projectFailure(error).message,
        });
      },
    );
  };
  return (
    <>
      <Command
        items={groups}
        filter={null}
        itemToStringValue={(item: Item) =>
          "create" in item ? item.create.path : "chat" in item ? chatLabel : item.name
        }
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
          {(group: { value: string; items: Item[] }) => (
            <CommandGroup key={group.value} items={group.items}>
              <CommandCollection>
                {(item: Item) =>
                  "chat" in item ? (
                    <CommandItem
                      key="chat"
                      value={item}
                      aria-label="Chat, no project"
                      aria-selected={props.project === chatChoice}
                      onClick={() => {
                        props.onProject(chatChoice);
                        props.onClose();
                      }}
                      className="h-auto min-h-9 text-ui"
                    >
                      <ChatCircleIcon aria-hidden size={16} />
                      <span className="min-w-0 flex-1 truncate">
                        {chatLabel}
                        <span className="ml-2 text-subtle-foreground">no project</span>
                      </span>
                      {props.project === chatChoice && <CheckIcon aria-hidden size={14} />}
                    </CommandItem>
                  ) : "create" in item ? (
                    <CommandItem
                      key={`create:${item.create.path}`}
                      value={item}
                      aria-label={`Create ${item.create.name} and add`}
                      disabled={creating}
                      onClick={() => make(item.create)}
                      className="h-auto min-h-9 text-ui"
                    >
                      <FolderPlusIcon aria-hidden size={16} className="text-primary!" />
                      <span className="shrink-0">
                        Create <b className="font-semibold">{item.create.name}</b> and add
                      </span>
                      <span className="min-w-0 flex-1 truncate text-right font-mono text-xs text-subtle-foreground">
                        {displayPath(item.create.path, typed.home)}
                      </span>
                    </CommandItem>
                  ) : (
                    <CommandItem
                      key={item.id}
                      value={item}
                      aria-label={item.name}
                      aria-selected={item.id === props.project}
                      onClick={() => {
                        props.onProject(item.id);
                        props.onClose();
                      }}
                      className="h-auto min-h-9 text-ui"
                    >
                      <ProjectMark id={item.id} badge={projectBadge(item)} />
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      {item.id === props.project && <CheckIcon aria-hidden size={14} />}
                    </CommandItem>
                  )
                }
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

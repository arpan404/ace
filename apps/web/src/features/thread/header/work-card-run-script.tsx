import { Autocomplete } from "@base-ui/react/autocomplete";
import { scriptChoices } from "@ace/ui-core";
import { MagnifyingGlassIcon, PlayIcon, PlusIcon } from "@phosphor-icons/react";
import { useState } from "react";
import {
  Command,
  CommandCollection,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  commandField,
} from "@/components/ui/command.tsx";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { cn } from "@/lib/cn.ts";
import { useRunScript, useScripts } from "../lib/use-scripts.ts";
import type { ThreadRef } from "../sources/index.ts";
import type { Script } from "../sources/workspace-source.ts";
import { RowLabel, RowSplit, rowIcon, splitCaret, splitMain } from "./work-card-parts.tsx";
import { ScriptConfigurationItems } from "./work-card-scripts.tsx";

/**
 * "Run a script": the project's scripts in a searchable list, each run in a terminal as before.
 * The + at the row's end edits the script files or adds one.
 */
export function RunScriptRow(props: { thread: ThreadRef; onClose(): void; onAddScript(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <RowSplit>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button type="button" className={splitMain}>
              <PlayIcon aria-hidden size={16} className={rowIcon} />
              <RowLabel>Run a script</RowLabel>
            </button>
          }
        />
        <PopoverContent align="start" aria-label="Run a script" className="w-[300px] p-0">
          {open && (
            <ScriptSearch
              thread={props.thread}
              onRan={() => {
                setOpen(false);
                props.onClose();
              }}
            />
          )}
        </PopoverContent>
      </Popover>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="Add project script"
              title="Add project script"
              className={splitCaret}
            >
              <PlusIcon aria-hidden size={14} />
            </button>
          }
        />
        <MenuContent align="end">
          <ScriptConfigurationItems
            thread={props.thread}
            onClose={props.onClose}
            onAddScript={props.onAddScript}
          />
        </MenuContent>
      </Menu>
    </RowSplit>
  );
}

/** The search field over the scripts it matches; Enter runs the highlighted one. */
function ScriptSearch(props: { thread: ThreadRef; onRan(): void }) {
  const query = useScripts(props.thread);
  const { run } = useRunScript(props.thread);
  const [text, setText] = useState("");
  const scripts = query.data ?? [];
  const groups = [{ value: "Scripts", items: scriptChoices(scripts, text) }];
  return (
    <Command
      items={groups}
      filter={null}
      itemToStringValue={(script: Script) => script.name}
      value={text}
      onValueChange={setText}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <MagnifyingGlassIcon aria-hidden size={16} className="shrink-0 text-muted-foreground" />
        <Autocomplete.Input
          autoFocus
          aria-label="Search scripts"
          placeholder="Search scripts…"
          className={cn(commandField, "text-ui")}
        />
      </div>
      {query.isError ? (
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="focus-ring m-1.5 rounded-md px-2.5 py-2 text-left text-ui text-muted-foreground hover:bg-accent"
        >
          Couldn't read scripts. Try again
        </button>
      ) : query.isPending ? (
        <p className="px-4 py-3 text-ui text-muted-foreground">Reading scripts…</p>
      ) : (
        <CommandEmpty>
          {scripts.length ? "No scripts match." : "No scripts in this project."}
        </CommandEmpty>
      )}
      <CommandList className="max-h-[min(320px,50dvh)] p-1.5">
        {(group: { value: string; items: Script[] }) => (
          <CommandGroup key={group.value} items={group.items}>
            <CommandCollection>
              {(script: Script) => (
                <CommandItem
                  key={script.id}
                  value={script}
                  aria-label={script.name}
                  aria-description={script.command}
                  onClick={() => {
                    void run(script);
                    props.onRan();
                  }}
                  className="h-8"
                >
                  <span className="min-w-0 flex-1 truncate">{script.name}</span>
                  <span className="ml-3 max-w-[55%] shrink-0 truncate font-mono text-xs text-subtle-foreground">
                    {script.command}
                  </span>
                </CommandItem>
              )}
            </CommandCollection>
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  );
}

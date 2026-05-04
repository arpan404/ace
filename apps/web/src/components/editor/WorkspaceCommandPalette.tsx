import type { ProjectEntry } from "@ace/contracts";
import {
  BotIcon,
  Code2Icon,
  FileSearchIcon,
  GitBranchIcon,
  MessageSquarePlusIcon,
  SearchIcon,
  WrenchIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { searchWorkspaceEntriesLocally } from "~/lib/editor/workspaceEntrySearch";
import { cn } from "~/lib/utils";
import { basenameOfPath } from "~/vscode-icons";

import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
} from "../ui/command";

export type WorkspaceCommandPaletteMode = "commands" | "files";

export interface WorkspaceCommandAction {
  readonly id: string;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly icon: "agent" | "code" | "fix" | "git" | "search" | "comment";
  readonly label: string;
  readonly shortcut?: string;
  readonly run: () => void;
}

function CommandIcon(props: { icon: WorkspaceCommandAction["icon"] }) {
  const className = "size-4 shrink-0 text-muted-foreground/72";
  switch (props.icon) {
    case "agent":
      return <BotIcon className={className} />;
    case "comment":
      return <MessageSquarePlusIcon className={className} />;
    case "fix":
      return <WrenchIcon className={className} />;
    case "git":
      return <GitBranchIcon className={className} />;
    case "search":
      return <FileSearchIcon className={className} />;
    case "code":
    default:
      return <Code2Icon className={className} />;
  }
}

export function WorkspaceCommandPalette(props: {
  entries: readonly ProjectEntry[];
  mode: WorkspaceCommandPaletteMode;
  onModeChange: (mode: WorkspaceCommandPaletteMode) => void;
  onOpenChange: (open: boolean) => void;
  onOpenFile: (path: string) => void;
  open: boolean;
  resolvedTheme: "light" | "dark";
  workspaceActions: readonly WorkspaceCommandAction[];
}) {
  const [query, setQuery] = useState("");
  const fileResults = useMemo(
    () =>
      searchWorkspaceEntriesLocally(
        props.entries.filter((entry) => entry.kind === "file"),
        query,
      ).slice(0, 80),
    [props.entries, query],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const commandResults = useMemo(
    () =>
      props.workspaceActions.filter((action) => {
        if (normalizedQuery.length === 0) {
          return true;
        }
        return `${action.label} ${action.description ?? ""}`
          .toLowerCase()
          .includes(normalizedQuery);
      }),
    [normalizedQuery, props.workspaceActions],
  );

  const showFiles = props.mode === "files";

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandDialogPopup className="max-w-2xl overflow-hidden border-primary/20 bg-popover/98 shadow-2xl shadow-black/18 backdrop-blur">
        <Command value={query} onValueChange={setQuery}>
          <CommandInput
            placeholder={showFiles ? "Open file by name or path" : "Run editor command"}
            onKeyDown={(event) => {
              if (event.key === ">") {
                props.onModeChange("commands");
              }
            }}
          />
          <CommandPanel>
            <CommandList>
              <CommandEmpty>No results.</CommandEmpty>
              {showFiles ? (
                <CommandGroup>
                  <CommandGroupLabel>Files</CommandGroupLabel>
                  {fileResults.map((entry) => (
                    <CommandItem
                      key={entry.path}
                      value={entry.path}
                      onClick={() => {
                        props.onOpenFile(entry.path);
                        props.onOpenChange(false);
                      }}
                      className="gap-2 rounded-sm data-[selected=true]:bg-primary/9"
                    >
                      <VscodeEntryIcon
                        pathValue={entry.path}
                        kind="file"
                        theme={props.resolvedTheme}
                        className="size-4"
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px]">
                        {basenameOfPath(entry.path)}
                      </span>
                      <span className="max-w-[55%] truncate text-[11px] text-muted-foreground/72">
                        {entry.path}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : (
                <CommandGroup>
                  <CommandGroupLabel>Editor Commands</CommandGroupLabel>
                  {commandResults.map((action) => (
                    <CommandItem
                      key={action.id}
                      value={action.label}
                      disabled={action.disabled}
                      onClick={() => {
                        if (action.disabled) {
                          return;
                        }
                        action.run();
                        props.onOpenChange(false);
                      }}
                      className={cn(
                        "gap-2 rounded-sm data-[selected=true]:bg-primary/9",
                        action.disabled && "opacity-45",
                      )}
                    >
                      <CommandIcon icon={action.icon} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px]">{action.label}</span>
                        {action.description ? (
                          <span className="block truncate text-[11px] text-muted-foreground/72">
                            {action.description}
                          </span>
                        ) : null}
                      </span>
                      {action.shortcut ? (
                        <CommandShortcut>{action.shortcut}</CommandShortcut>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <span className="inline-flex items-center gap-1.5">
              <SearchIcon className="size-3.5" />
              {showFiles ? "File quick open" : "Command palette"}
            </span>
            <span>{showFiles ? "Cmd+P" : "Cmd+Shift+P"}</span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

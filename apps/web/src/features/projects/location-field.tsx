import { FolderSimpleIcon } from "@phosphor-icons/react";
import { displayPath } from "@ace/ui-core";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import type { Machine } from "@/lib/machines.ts";
import { FolderSearchBox } from "./folder-search.tsx";
import { useFolderListing } from "./use-folders.ts";
import { useFolderSearch } from "./use-folder-search.ts";

/**
 * Where a new project goes on `machine`: the folder browsed in a search box in `location`
 * mode, else `suggested` (a path the caller proposes, like where recent projects live), else
 * where browsing starts. What was typed belongs to the machine it was typed for. Also the
 * folder names already there, for name checks.
 */
export function useLocation(options: {
  machine: Machine;
  machines: readonly Machine[];
  suggested?: string | undefined;
}) {
  const { machine } = options;
  const [typed, setTyped] = useState<{ machine: string; text: string }>();
  const text =
    typed?.machine === machine.id
      ? typed.text
      : options.suggested
        ? `${options.suggested.replace(/\/+$/, "")}/`
        : "";
  const search = useFolderSearch({ machine, machines: options.machines, text, mode: "location" });
  const location = search.query.kind === "path" ? search.query.directory : search.home?.start;
  const siblings = useFolderListing(machine, location, true).entries?.map((entry) => entry.name);
  return {
    text,
    setText: (next: string) => setTyped({ machine: machine.id, text: next }),
    search,
    location,
    home: search.home,
    siblings,
  };
}

export type LocationState = ReturnType<typeof useLocation>;

/** The location, and the search box that changes it. */
export function LocationField(props: {
  state: LocationState;
  several: boolean;
  disabled?: boolean;
}) {
  const { state } = props;
  return (
    <div className="grid gap-1.5">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="font-medium text-muted-foreground">Location</span>
        <Icon icon={FolderSimpleIcon} size={14} className="text-subtle-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground">
          {state.location ? displayPath(state.location, state.home?.path) : "…"}
        </span>
      </div>
      <FolderSearchBox
        label="Search for a location"
        listLabel="Folders for the new project"
        placeholder="Search, or type a path: / ~ ./"
        search={state.search}
        text={state.text}
        onText={state.setText}
        mode="location"
        several={props.several}
        {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
        listClassName="h-40"
      />
    </div>
  );
}

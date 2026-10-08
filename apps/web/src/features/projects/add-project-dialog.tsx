import { DownloadSimpleIcon, FolderOpenIcon, FolderPlusIcon } from "@phosphor-icons/react";
import { useState, type KeyboardEvent } from "react";
import { Icon } from "@/components/icon.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs.tsx";
import { applePlatform } from "@/lib/keymap.ts";
import { useMachines, type Machine } from "@/lib/machines.ts";
import { CloneProjectTab } from "./clone-project-tab.tsx";
import { CreateProjectTab } from "./create-project-tab.tsx";
import type { LandOptions } from "./land.ts";
import { MachinePicker, nextMachine } from "./machine-picker.tsx";
import { OpenFolderTab } from "./open-folder-tab.tsx";
import type { Added } from "./project-commands.ts";
import type { AddTab, FolderAttempt } from "./requests.ts";
import type { CloneControl } from "./use-clone-run.ts";

const tabs: { value: AddTab; label: string; icon: typeof FolderOpenIcon }[] = [
  { value: "open", label: "Open folder", icon: FolderOpenIcon },
  { value: "create", label: "New project", icon: FolderPlusIcon },
  { value: "clone", label: "Clone", icon: DownloadSimpleIcon },
];

/** ←/→ switch tabs from a text box only while it is empty, so they still move the caret. */
function emptyTextBox(target: EventTarget): boolean {
  return target instanceof HTMLInputElement && target.type === "text" && target.value === "";
}

/**
 * Add project: open a folder already on a machine, create a new one (optionally a Git
 * repository), or clone a repository with the person's own Git credentials. With more than one
 * machine connected, a picker at the top chooses which one everything below works on (⌘M
 * cycles); ⌘1–⌘3 switch tabs, as do ←/→ from an empty box. Each machine checks every path
 * against the places it may open.
 */
export function AddProjectDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  tab: AddTab;
  onTab(tab: AddTab): void;
  attempt: FolderAttempt | undefined;
  clone: CloneControl;
  onAdded(result: Added, verb: string, options: LandOptions): void;
}) {
  const machines = useMachines();
  const [chosen, setChosen] = useState<{ id: string; name: string; primary: boolean }>();
  const choose = (id: string | undefined) => {
    const next = machines.find((each) => each.id === id);
    if (next) setChosen({ id: next.id, name: next.name, primary: next.primary });
  };
  // This window's daemon is found by being primary: its id becomes its host id once known.
  const found =
    chosen && machines.find((each) => each.id === chosen.id || (chosen.primary && each.primary));
  // A chosen machine that leaves the pool stays chosen, unreachable, until another is picked:
  // nothing typed for it may land on a different machine.
  const removed = chosen !== undefined && found === undefined;
  const machine: Machine | undefined = chosen
    ? (found ?? { ...chosen, status: "offline", client: undefined })
    : machines[0];
  const several = machines.length > 1 || removed;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = applePlatform ? event.metaKey : event.ctrlKey;
    const at = tabs.findIndex((tab) => tab.value === props.tab);
    let next: AddTab | undefined;
    if (mod && !event.shiftKey && !event.altKey && /^[1-3]$/.test(event.key))
      next = tabs[Number(event.key) - 1]?.value;
    else if (mod && event.key.toLowerCase() === "m" && several && machine) {
      event.preventDefault();
      choose(nextMachine(machines, machine.id)?.id);
      return;
    } else if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      !mod &&
      !event.shiftKey &&
      !event.altKey &&
      emptyTextBox(event.target)
    )
      next = tabs[(at + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]?.value;
    if (!next) return;
    event.preventDefault();
    props.onTab(next);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent size="lg" className="gap-3" onKeyDown={onKeyDown}>
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>
            A project is a folder on one of your machines. Agents work in it with that machine's
            tools and Git credentials.
          </DialogDescription>
        </DialogHeader>
        {several && machine && (
          <MachinePicker machines={machines} value={machine.id} onValue={choose} />
        )}
        <Tabs
          value={props.tab}
          onValueChange={(value) => {
            const tab = tabs.find((each) => each.value === value);
            if (tab) props.onTab(tab.value);
          }}
          className="grid min-w-0 gap-3"
        >
          <TabsList aria-label="How to add a project">
            {tabs.map((tab, index) => (
              <TabsTab key={tab.value} value={tab.value}>
                <Icon icon={tab.icon} size={14} />
                {tab.label}
                <Kbd
                  aria-hidden
                  keys={`mod+${index + 1}`}
                  variant="bare"
                  className="hidden sm:inline-flex"
                />
              </TabsTab>
            ))}
          </TabsList>
          {machine && machine.status !== "online" && (
            <p role="status" className="text-sm text-muted-foreground">
              {removed
                ? `${machine.name} was removed from your machines. Choose a machine to carry on.`
                : machine.primary
                  ? "Reconnecting to this computer… Folders and actions come back once it answers."
                  : `${machine.name} isn't connected. Folders and actions come back once it is.`}
            </p>
          )}
          {machine && (
            <>
              <TabsPanel className="min-w-0" value="open">
                <OpenFolderTab
                  machine={machine}
                  machines={machines}
                  attempt={machine.primary ? props.attempt : undefined}
                  onAdded={(result, mode, on) =>
                    props.onAdded(result, "Added", { mode, machine: on })
                  }
                />
              </TabsPanel>
              <TabsPanel className="min-w-0" value="create">
                <CreateProjectTab
                  machine={machine}
                  machines={machines}
                  onAdded={(result, on) =>
                    props.onAdded(result, "Created", { mode: "thread", machine: on })
                  }
                />
              </TabsPanel>
              <TabsPanel className="min-w-0" value="clone">
                <CloneProjectTab machine={machine} machines={machines} clone={props.clone} />
              </TabsPanel>
            </>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

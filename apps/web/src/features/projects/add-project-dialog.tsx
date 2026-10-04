import { DownloadSimpleIcon, FolderOpenIcon, FolderPlusIcon } from "@phosphor-icons/react";
import { useConnectionState } from "@ace/client-react";
import { Icon } from "@/components/icon.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs.tsx";
import { CloneProjectTab } from "./clone-project-tab.tsx";
import { CreateProjectTab } from "./create-project-tab.tsx";
import { OpenFolderTab } from "./open-folder-tab.tsx";
import type { Added } from "./project-commands.ts";
import type { AddTab, FolderAttempt } from "./requests.ts";
import type { CloneControl } from "./use-clone-run.ts";

const tabs: { value: AddTab; label: string; icon: typeof FolderOpenIcon }[] = [
  { value: "open", label: "Open folder", icon: FolderOpenIcon },
  { value: "create", label: "Create new", icon: FolderPlusIcon },
  { value: "clone", label: "Clone repository", icon: DownloadSimpleIcon },
];

/**
 * Add project: open a folder already on the daemon's machine, create a new one (optionally a
 * Git repository), or clone a repository with the person's own Git credentials. Every path is
 * on the daemon's machine; the daemon checks each one against the places it may open.
 */
export function AddProjectDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  tab: AddTab;
  onTab(tab: AddTab): void;
  attempt: FolderAttempt | undefined;
  clone: CloneControl;
  onAdded(result: Added, verb: string): void;
}) {
  const offline = useConnectionState() !== "ready";
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="w-[min(620px,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>
            A project is a folder on the daemon's machine. Agents work in it with your own tools and
            Git credentials.
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={props.tab}
          onValueChange={(value) => {
            const next = tabs.find((tab) => tab.value === value);
            if (next) props.onTab(next.value);
          }}
          className="grid gap-4"
        >
          <TabsList aria-label="How to add a project">
            {tabs.map((tab) => (
              <TabsTab key={tab.value} value={tab.value}>
                <Icon icon={tab.icon} size={14} />
                {tab.label}
              </TabsTab>
            ))}
          </TabsList>
          {offline && (
            <p role="status" className="text-sm text-muted-foreground">
              Reconnecting to the daemon… Folders and actions come back once it answers.
            </p>
          )}
          <TabsPanel value="open">
            <OpenFolderTab
              attempt={props.attempt}
              offline={offline}
              onAdded={(result) => props.onAdded(result, "Added")}
            />
          </TabsPanel>
          <TabsPanel value="create">
            <CreateProjectTab
              offline={offline}
              onAdded={(result) => props.onAdded(result, "Created")}
            />
          </TabsPanel>
          <TabsPanel value="clone">
            <CloneProjectTab offline={offline} clone={props.clone} />
          </TabsPanel>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

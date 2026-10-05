import { FolderOpenIcon, FolderSimpleIcon, FolderPlusIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { Icon } from "@/components/icon.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useProjectName } from "@/lib/projects.ts";
import { useProjectDialogs } from "@/features/projects/index.ts";
import { useOrganizerState } from "@/features/organize/index.ts";
import { NeedsDaemon, useDaemonReachable } from "./needs-daemon.tsx";
import { ProjectFilter } from "./project-filter.tsx";

/** The quiet heading over pinned threads. */
export function PinnedLabel() {
  return (
    <h3 className="flex h-9 items-end pb-1.5 pl-[11px] text-ui text-subtle-foreground">Pinned</h3>
  );
}

/**
 * The Threads heading's project filter and Add project: out of the way until the pointer or
 * keyboard is on the heading, or a filter narrows the list.
 */
export function ThreadsActions() {
  const { project } = useOrganizerState();
  const dialogs = useProjectDialogs();
  // Adding a project browses the daemon's folders, which can't wait for a reconnect.
  const reachable = useDaemonReachable();
  return (
    <span
      className={cn(
        "flex items-center gap-0.5 opacity-0 transition-opacity duration-(--dur-1) group-focus-within/heading:opacity-100 group-hover/heading:opacity-100",
        project !== null && "opacity-100",
      )}
    >
      <ProjectFilter />
      <NeedsDaemon reachable={reachable}>
        <IconButton
          icon={FolderPlusIcon}
          label="Add project"
          shortcut="addProject"
          tooltip={reachable}
          disabled={!reachable}
          focusableWhenDisabled
          onClick={() => dialogs.open({ kind: "add", tab: "open" })}
          onPointerEnter={dialogs.preload}
          className="size-[26px] rounded-sm hover:bg-sidebar-accent data-disabled:pointer-events-auto"
        />
      </NeedsDaemon>
    </span>
  );
}

/** A project's folder: opens and closes its threads; closed, it still says when one needs you. */
export function FolderRow(props: {
  project: string;
  open: boolean;
  needsYou: boolean;
  onToggle(): void;
}) {
  const name = useProjectName()(props.project);
  const waiting = !props.open && props.needsYou;
  return (
    <button
      type="button"
      aria-expanded={props.open}
      onClick={props.onToggle}
      className="flex h-[30px] w-full items-center gap-[9px] rounded-md px-[11px] text-left text-base text-sidebar-foreground outline-none transition-colors duration-(--dur-1) hover:bg-sidebar-accent focus-visible:shadow-[inset_0_0_0_2px_var(--ring)]"
    >
      <Icon
        icon={props.open ? FolderOpenIcon : FolderSimpleIcon}
        className="text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {waiting && <Dot tone="needs-you" label="A thread here needs you" />}
    </button>
  );
}

/** Past a folder's first threads: show the rest, or go back to the first few. */
export function ShowMore(props: { project: string; showingAll: boolean; onToggle(): void }) {
  const name = useProjectName()(props.project);
  const words = props.showingAll ? "Show less" : "Show more";
  return (
    <button
      type="button"
      onClick={props.onToggle}
      aria-label={`${words} in ${name}`}
      className="mb-2 flex h-7 w-full items-center rounded-md pl-9 text-left text-base text-subtle-foreground outline-none transition-colors duration-(--dur-1) hover:text-foreground focus-visible:shadow-[inset_0_0_0_2px_var(--ring)]"
    >
      {words}
    </button>
  );
}

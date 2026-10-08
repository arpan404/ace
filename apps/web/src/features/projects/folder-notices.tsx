import {
  FolderSimpleIcon,
  GitBranchIcon,
  HouseSimpleIcon,
  LockSimpleIcon,
  WifiSlashIcon,
} from "@phosphor-icons/react";
import { displayPath, type ProjectProblem } from "@ace/ui-core";
import type { ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";

/** A quiet state in place of the list: offline, empty, refused. */
export function Notice(props: {
  icon: typeof FolderSimpleIcon;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-ui text-muted-foreground"
    >
      <Icon icon={props.icon} size={20} />
      <div className="max-w-[46ch]">{props.children}</div>
      {props.action}
    </div>
  );
}

export const offlineIcon = WifiSlashIcon;
export const deniedIcon = LockSimpleIcon;

/**
 * The places a daemon may open (home, or `projects.roots`), each one click away: shown when a
 * folder is outside them.
 */
export function AllowedPlaces(props: {
  roots: readonly string[];
  home: string | undefined;
  onGo(path: string): void;
  className?: string;
}) {
  if (props.roots.length === 0) return null;
  return (
    <div
      className={cn("flex flex-wrap items-center justify-center gap-1 text-sm", props.className)}
    >
      <span className="mr-1 text-subtle-foreground">Allowed places</span>
      {props.roots.map((root) => (
        <Button
          key={root}
          size="sm"
          variant="ghost"
          aria-label={
            root === props.home ? "Go to the home folder" : `Go to ${displayPath(root, props.home)}`
          }
          onClick={() => props.onGo(root)}
        >
          {root === props.home && <Icon icon={HouseSimpleIcon} size={13} />}
          <span className="font-mono text-sm">{displayPath(root, props.home)}</span>
        </Button>
      ))}
    </div>
  );
}

/** Why a folder couldn't be read, with the way back to somewhere it can. */
export function RefusedNotice(props: {
  problem: ProjectProblem;
  roots: readonly string[];
  home: string | undefined;
  onGo(path: string): void;
  onRetry(): void;
  allow?: ReactNode;
}) {
  return (
    <Notice
      icon={props.problem.denied ? LockSimpleIcon : FolderSimpleIcon}
      action={
        props.problem.denied ? (
          <>
            {props.allow}
            <AllowedPlaces roots={props.roots} home={props.home} onGo={props.onGo} />
          </>
        ) : (
          <Button size="sm" onClick={props.onRetry}>
            Try again
          </Button>
        )
      }
    >
      {props.problem.message}
    </Notice>
  );
}

/** A small label after a folder's name: Git, Project, a machine. */
export function Badge(props: { children: ReactNode; icon?: typeof GitBranchIcon }) {
  return (
    <span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-xs bg-foreground/5 px-1.5 text-xs font-medium text-muted-foreground">
      {props.icon && <Icon icon={props.icon} size={12} />}
      {props.children}
    </span>
  );
}

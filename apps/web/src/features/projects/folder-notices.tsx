import { displayPath, type ProjectProblem } from "@ace/ui-core";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { ListStatus } from "@/components/ui/list-viewport.tsx";
import { cn } from "@/lib/cn.ts";

/*
 * What a folder list says in place of its rows, and the quiet words after a folder's name.
 * Statuses are one plain sentence from the left with text buttons after it (`ListStatus`).
 */

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
    <span className={cn("inline-flex flex-wrap items-center gap-1 text-sm", props.className)}>
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
          <span className="font-mono text-sm">{displayPath(root, props.home)}</span>
        </Button>
      ))}
    </span>
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
    <ListStatus
      actions={
        props.problem.denied ? (
          <>
            {props.allow}
            <AllowedPlaces roots={props.roots} home={props.home} onGo={props.onGo} />
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={props.onRetry}>
            Retry
          </Button>
        )
      }
    >
      {props.problem.message}
    </ListStatus>
  );
}

/** A quiet word after a folder's name: Git, Project. */
export function RowMeta(props: { children: ReactNode }) {
  return <span className="shrink-0 text-xs text-subtle-foreground">{props.children}</span>;
}

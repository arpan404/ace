import type { ReactNode } from "react";
import { formatCount } from "@ace/ui-core";
import { CaretDownIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";

/** A section's small muted label, with how many rows it holds when that helps. */
function Label(props: { name: string; count?: number | undefined }) {
  return (
    <>
      <span className="text-xs font-medium text-muted-foreground">{props.name}</span>
      {props.count !== undefined && (
        <span aria-hidden className="text-xs text-subtle-foreground tabular-nums">
          {formatCount(props.count)}
        </span>
      )}
    </>
  );
}

/** A section of the summary: a small muted label, when there is more than one, over its rows. */
export function Section(props: {
  name: string;
  labelled: boolean;
  count?: number | undefined;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={props.name} className="min-w-0">
      {(props.labelled || props.aside) && (
        <div className="flex h-7 min-w-0 items-center gap-1.5 px-2">
          {props.labelled && (
            <h3 className="flex min-w-0 items-baseline gap-1.5">
              <Label name={props.name} count={props.count} />
            </h3>
          )}
          {props.aside}
        </div>
      )}
      {props.children}
    </section>
  );
}

/**
 * A section folded until the person opens it ("Done 24"), its header the disclosure. Whether it
 * is open is kept with the tab under `fold`.
 */
export function FoldedSection(props: {
  name: string;
  count: number;
  fold: string;
  threadId: string;
  children: ReactNode;
}) {
  const workspace = useScopeWorkspace(props.threadId);
  const actions = useWorkspaceActions(props.threadId);
  const sections = workspace.tabs.find((tab) => tab.key === "work")?.ui?.sections;
  const open = sections?.[props.fold] === true;
  return (
    <section aria-label={props.name} className="min-w-0">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${formatCount(props.count)} ${props.name.toLowerCase()}`}
          onClick={() =>
            actions.updateUi("work", { sections: { ...sections, [props.fold]: !open } })
          }
          className="group/fold focus-ring-inset flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left hover:bg-accent"
        >
          <Label name={props.name} count={props.count} />
          <CaretDownIcon
            aria-hidden
            size={12}
            className={cn(
              "text-faint-foreground transition-transform duration-(--motion-base) ease-out group-hover/fold:text-muted-foreground",
              !open && "-rotate-90",
            )}
          />
        </button>
      </h3>
      {open && props.children}
    </section>
  );
}

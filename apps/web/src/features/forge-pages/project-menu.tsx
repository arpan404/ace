import { useRef, useState, type KeyboardEvent } from "react";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { projectBadge } from "@ace/ui-core";
import { ProjectMark } from "@/components/project-mark.tsx";
import { SearchField } from "@/components/search-field.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { cn } from "@/lib/cn.ts";
import { toggleProject } from "@/lib/forge-projects.ts";
import type { ProjectChoice } from "./project-choice.ts";

const optionClass =
  "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-ui text-foreground focus-ring-inset hover:bg-hover";

function Tick(props: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-3.5 shrink-0 place-items-center rounded-xs shadow-[inset_0_0_0_1px_var(--input)]",
        props.on && "bg-tint text-tint-foreground shadow-none",
      )}
    >
      {props.on && <CheckIcon size={10} weight="bold" />}
    </span>
  );
}

/** ↑/↓ between the menu's options and its find field, the way a menu moves. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const options = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-project-option]")];
  if (!options.length) return;
  event.preventDefault();
  const at = options.indexOf(document.activeElement as HTMLElement);
  const step = event.key === "ArrowDown" ? 1 : -1;
  options[(at + step + options.length) % options.length]?.focus();
}

/**
 * Which projects the list shows, first in its bar: "All projects", one name, two, or "N
 * projects". The menu ticks projects in or out, or keeps "Only" one, with each project's open
 * count, and finds one by name when there are many.
 */
export function ProjectMenu(props: {
  choice: ProjectChoice;
  /** Open items per project, once read. */
  counts?: ReadonlyMap<string, number> | undefined;
  onPick(next: string[]): void;
}) {
  const { choice, counts } = props;
  const [find, setFind] = useState("");
  const [open, setOpen] = useState(false);
  // A tick changes the address, which closes popovers: the menu stays open for the next tick.
  const ticking = useRef(false);
  const tick = (next: string[]) => {
    ticking.current = true;
    props.onPick(next);
    requestAnimationFrame(() => {
      ticking.current = false;
    });
  };
  const choose = (next: string[]) => {
    setOpen(false);
    props.onPick(next);
  };
  const words = find.trim().toLowerCase();
  const shown = choice.all.filter((id) => !words || choice.name(id).toLowerCase().includes(words));
  // Every project's count, or none: a sum of some would read as the whole.
  const total =
    counts && choice.all.every((id) => counts.has(id))
      ? choice.all.reduce((sum, id) => sum + (counts.get(id) ?? 0), 0)
      : undefined;
  const marks = choice.picked.slice(0, 3);
  if (choice.all.length < 2) return null;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next && ticking.current) return;
        setOpen(next);
        if (!next) setFind("");
      }}
    >
      <PopoverTrigger
        aria-label={`Projects: ${choice.label}`}
        className="mr-1 inline-flex h-7 max-w-48 min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui font-medium text-foreground focus-ring transition-colors duration-(--motion-fast) hover:bg-hover aria-expanded:bg-hover"
      >
        {marks.length > 0 && (
          <span aria-hidden className="flex shrink-0 gap-0.5">
            {marks.map((id) => (
              <ProjectMark key={id} id={id} badge={projectBadge({ id, name: choice.name(id) })} />
            ))}
          </span>
        )}
        <span className="min-w-0 truncate">{choice.label}</span>
        <CaretDownIcon aria-hidden size={13} className="shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        aria-label="Projects"
        className="flex w-72 max-w-[calc(100vw-1rem)] flex-col gap-0.5 p-1.5"
        initialFocus
      >
        <div role="group" aria-label="Projects" onKeyDown={moveFocus} className="flex flex-col">
          {choice.all.length > 6 && (
            <SearchField
              label="Find a project"
              placeholder="Find a project"
              value={find}
              onValueChange={setFind}
              className="mb-1"
            />
          )}
          <button
            type="button"
            role="checkbox"
            aria-checked={choice.picked.length === 0}
            data-project-option=""
            className={optionClass}
            onClick={() => choose([])}
          >
            <Tick on={choice.picked.length === 0} />
            <span className="flex-1">All projects</span>
            {total !== undefined && (
              <span className="text-xs text-subtle-foreground tabular-nums">{total}</span>
            )}
          </button>
          <span aria-hidden className="mx-0.5 my-1 h-px bg-border" />
          <div className="max-h-72 overflow-y-auto">
            {shown.map((id) => {
              const on = choice.picked.includes(id);
              const count = counts?.get(id);
              return (
                <div key={id} className="group/option flex items-center">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    data-project-option=""
                    className={optionClass}
                    onClick={() => tick(toggleProject(choice.picked, id, choice.all))}
                  >
                    <Tick on={on} />
                    <ProjectMark id={id} badge={projectBadge({ id, name: choice.name(id) })} />
                    <span className="min-w-0 flex-1 truncate">{choice.name(id)}</span>
                    {count !== undefined && (
                      <span className="text-xs text-subtle-foreground tabular-nums group-focus-within/option:hidden group-hover/option:hidden">
                        {count}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    data-project-option=""
                    aria-label={`Only ${choice.name(id)}`}
                    className="hidden h-8 shrink-0 rounded-md px-2 text-xs text-muted-foreground focus-ring-inset group-focus-within/option:block group-hover/option:block hover:bg-hover hover:text-foreground"
                    onClick={() => choose([id])}
                  >
                    Only
                  </button>
                </div>
              );
            })}
            {!shown.length && (
              <p className="px-1.5 py-2 text-ui text-muted-foreground">No project matches</p>
            )}
          </div>
        </div>
        <p className="px-1.5 pt-1 pb-0.5 text-xs text-subtle-foreground">
          Tick to add projects, or choose Only for just one.
        </p>
      </PopoverContent>
    </Popover>
  );
}

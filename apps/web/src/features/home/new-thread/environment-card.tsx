import type { WorktreeBase } from "@ace/protocol";
import { baseOptions, sameBase, type BaseOption } from "@ace/ui-core";
import {
  CheckIcon,
  GitForkIcon,
  LaptopIcon,
  MagnifyingGlassIcon,
  XIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { useId, useState, type KeyboardEvent } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { AttachedCard } from "@/features/thread/index.ts";
import type { BaseRefs } from "@/lib/branches.ts";
import { cn } from "@/lib/cn.ts";
import type { WorkMode } from "./choices.ts";

const places: { mode: WorkMode; icon: PhosphorIcon; title: string; hint: string }[] = [
  {
    mode: "worktree",
    icon: GitForkIcon,
    title: "New worktree",
    hint: "A branch and folder of its own; your checkout stays as it is.",
  },
  {
    mode: "local",
    icon: LaptopIcon,
    title: "Local checkout",
    hint: "Works directly in the project's folder, on its current branch.",
  },
];

/**
 * Where a new thread runs, attached to the composer: a new worktree or the local checkout, and
 * for a worktree the branch it starts from, local or on a remote, found by typing. The remote's
 * copy of the default branch is offered first; it is fetched just before the worktree is made.
 */
export function NewThreadEnvironmentCard(props: {
  id: string;
  mode: WorkMode;
  onMode(mode: WorkMode): void;
  branches: BaseRefs;
  base: WorktreeBase | undefined;
  onBase(base: WorktreeBase): void;
  onClose(): void;
}) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    props.onClose();
  };
  return (
    <AttachedCard label="Where this thread runs" cardKey="environment" onKeyDown={onKeyDown}>
      <div id={props.id} className="px-4 pt-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-ui font-medium text-foreground">Where should it run?</h3>
          <IconButton icon={XIcon} label="Close" size="sm" onClick={props.onClose} />
        </div>
        <div
          role="radiogroup"
          aria-label="Where the work happens"
          className="mt-2 grid gap-2 sm:grid-cols-2"
        >
          {places.map((place) => {
            const checked = props.mode === place.mode;
            return (
              <button
                key={place.mode}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => props.onMode(place.mode)}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors duration-(--dur-1) focus-ring",
                  checked
                    ? "bg-accent shadow-[inset_0_0_0_1px_var(--ring)]"
                    : "bg-muted hover:bg-accent",
                )}
              >
                <place.icon
                  aria-hidden
                  size={18}
                  className="mt-px shrink-0 text-muted-foreground"
                />
                <span className="min-w-0">
                  <span className="block text-ui font-medium text-foreground">{place.title}</span>
                  <span className="block text-xs text-subtle-foreground">{place.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
        {props.mode === "worktree" && (
          <BasePicker branches={props.branches} base={props.base} onBase={props.onBase} />
        )}
      </div>
    </AttachedCard>
  );
}

/** The branches a worktree can start from, remote ones first, narrowed as the person types. */
function BasePicker(props: {
  branches: BaseRefs;
  base: WorktreeBase | undefined;
  onBase(base: WorktreeBase): void;
}) {
  const [query, setQuery] = useState("");
  // Until the person moves it, the highlight rests on the base already picked.
  const [highlight, setHighlight] = useState<number>();
  const listId = useId();
  const { refs, defaultBranch, state } = props.branches;
  const groups = baseOptions(refs, defaultBranch, query);
  const remotes = [...new Set(groups.remote.map((option) => option.base.remote))];
  const flat = [...groups.remote, ...groups.local];
  const picked = flat.findIndex((option) => sameBase(option.base, props.base));
  const active = Math.min(highlight ?? Math.max(0, picked), Math.max(0, flat.length - 1));
  const optionId = (index: number) => `${listId}-${index}`;
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!flat.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((active + step + flat.length) % flat.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = flat[active];
      if (option) props.onBase(option.base);
    }
  };
  const group = (title: string, options: BaseOption[], offset: number) =>
    options.length > 0 && (
      <li role="presentation">
        <p className="px-2.5 pt-2 pb-1 text-xs font-medium text-subtle-foreground">{title}</p>
        <ul role="group" aria-label={title}>
          {options.map((option, index) => {
            const at = offset + index;
            const chosen = sameBase(option.base, props.base);
            return (
              <li
                key={option.label}
                id={optionId(at)}
                role="option"
                aria-selected={chosen}
                onMouseDown={(event) => event.preventDefault()}
                // Pointer movement only: a list moving under a still cursor doesn't pick a row.
                onMouseMove={() => at !== active && setHighlight(at)}
                onClick={() => props.onBase(option.base)}
                className={cn(
                  "flex h-8 cursor-default items-center gap-2 rounded-md px-2.5 text-ui",
                  at === active && "bg-accent",
                )}
              >
                <span className="min-w-0 truncate font-mono text-sm text-foreground">
                  {option.label}
                </span>
                {option.note && (
                  <span className="min-w-0 shrink truncate text-xs text-subtle-foreground">
                    {option.note}
                  </span>
                )}
                {chosen && (
                  <CheckIcon aria-hidden size={14} className="ml-auto shrink-0 text-foreground" />
                )}
              </li>
            );
          })}
        </ul>
      </li>
    );
  return (
    <div className="mt-3">
      <label className="flex h-9 items-center gap-2 rounded-md bg-muted px-2.5 text-ui text-muted-foreground focus-within:shadow-[inset_0_0_0_1px_var(--ring)]">
        <MagnifyingGlassIcon aria-hidden size={14} className="shrink-0" />
        <input
          // Opening the card is for choosing: typing narrows the branches straight away.
          autoFocus
          role="combobox"
          aria-label="Start from branch"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={flat.length ? optionId(active) : undefined}
          aria-autocomplete="list"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlight(event.target.value.trim() ? 0 : undefined);
          }}
          onKeyDown={onKeyDown}
          placeholder="Start from a branch…"
          className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-subtle-foreground"
        />
      </label>
      {state === "loading" ? (
        <p
          role="status"
          className="flex h-9 items-center gap-2 px-2.5 text-ui text-muted-foreground"
        >
          <Spinner /> Reading the branches…
        </p>
      ) : state === "failed" ? (
        <p role="status" className="flex h-9 items-center px-2.5 text-ui text-muted-foreground">
          Couldn't read the branches; it starts from the current one.
        </p>
      ) : flat.length === 0 ? (
        <p role="status" className="flex h-9 items-center px-2.5 text-ui text-muted-foreground">
          {query.trim() ? `No branch matches “${query.trim()}”` : "No branches"}
        </p>
      ) : (
        <ul
          id={listId}
          role="listbox"
          aria-label="Branches"
          className="mt-1 max-h-56 overflow-y-auto overscroll-contain"
        >
          {group(remotes.length === 1 ? `On ${remotes[0]}` : "On remotes", groups.remote, 0)}
          {group("Local", groups.local, groups.remote.length)}
        </ul>
      )}
    </div>
  );
}

import type { WorktreeBase } from "@ace/protocol";
import { baseOptions, sameBase, type BaseOption } from "@ace/ui-core";
import { CheckIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useId, useState, type KeyboardEvent } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import type { BaseRefs } from "@/lib/branches.ts";
import { cn } from "@/lib/cn.ts";

/** The branches a worktree can start from, remote ones first, narrowed as the person types. */
export function BasePicker(props: {
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
    <div>
      {/* The field is the box, so its focus edge goes round the glass too. */}
      <div className="relative text-ui">
        <MagnifyingGlassIcon
          aria-hidden
          size={14}
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
        />
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
          className="h-9 w-full rounded-md bg-transparent pr-2.5 pl-8 text-foreground shadow-[inset_0_0_0_1px_var(--input)] outline-none placeholder:text-subtle-foreground focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]"
        />
      </div>
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

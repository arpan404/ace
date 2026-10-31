import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { projectBadge } from "@ace/ui-core";
import type { KeyboardEvent } from "react";
import { Icon } from "@/components/icon.tsx";
import { fieldClassName } from "@/components/ui/input.tsx";
import { cn } from "@/lib/cn.ts";
import { useResolvedKeymap } from "@/lib/keybindings.ts";
import { formatKeys } from "@/lib/keymap.ts";
import { useProjectName } from "@/lib/projects.ts";
import { ProjectMark } from "./row-parts.tsx";

/**
 * The panel's search: typing narrows the list at once (settled matches follow under their own
 * heading). Escape clears it, and a second Escape leaves the field; ↓ moves into the list. The
 * palette's shortcut shows at the end while it is ⌘K, the wider search one key away.
 */
export function PanelSearch(props: {
  value: string;
  onChange(value: string): void;
  /** Move focus to the list's first row. */
  onEnterList(): void;
}) {
  const palette = useResolvedKeymap().palette;
  const hint = palette === "mod+k" ? formatKeys(palette) : undefined;
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (props.value) props.onChange("");
      else event.currentTarget.blur();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      props.onEnterList();
    }
  };
  return (
    <label
      className={cn(
        fieldClassName,
        "mx-2 mb-1.5 flex h-8 w-auto shrink-0 items-center gap-2 px-2.5 text-subtle-foreground focus-within:shadow-[0_0_0_1px_color-mix(in_oklab,var(--ring)_50%,transparent)]",
      )}
    >
      <Icon icon={MagnifyingGlassIcon} size={14} />
      <input
        type="search"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search all threads"
        aria-label="Search all threads"
        spellCheck={false}
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-subtle-foreground [&::-webkit-search-cancel-button]:hidden"
      />
      {props.value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => props.onChange("")}
          className="grid size-5 shrink-0 place-items-center rounded-sm text-subtle-foreground hover:text-foreground focus-ring"
        >
          <XIcon aria-hidden size={12} />
        </button>
      ) : (
        hint && (
          <kbd aria-hidden className="shrink-0 font-mono text-2xs text-subtle-foreground">
            {hint}
          </kbd>
        )
      )}
    </label>
  );
}

export type PanelTab = "active" | "settled";

/** "Active N" and "Settled N": words, not a segmented control. The chosen one reads in full ink. */
export function PanelTabs(props: {
  tab: PanelTab;
  active: number;
  settled: number;
  onChange(tab: PanelTab): void;
}) {
  const tabs: { id: PanelTab; label: string; count: number }[] = [
    { id: "active", label: "Active", count: props.active },
    { id: "settled", label: "Settled", count: props.settled },
  ];
  return (
    <div role="tablist" aria-label="Threads" className="flex shrink-0 gap-3.5 px-4 pt-0.5 pb-2">
      {tabs.map((tab) => {
        const selected = tab.id === props.tab;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => props.onChange(tab.id)}
            className={cn(
              "rounded-xs py-0.5 text-ui font-medium transition-colors duration-(--motion-fast) focus-ring",
              selected ? "text-foreground" : "text-subtle-foreground hover:text-muted-foreground",
            )}
          >
            {tab.label} <span className="font-normal tabular-nums">{tab.count}</span>
          </button>
        );
      })}
    </div>
  );
}

const chip = (selected: boolean) =>
  cn(
    "inline-flex h-6 max-w-40 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors duration-(--motion-fast) focus-ring",
    selected
      ? "bg-active text-foreground"
      : "text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover hover:text-foreground",
  );

/** The Settled tab's project chips: All, then each project with settled threads. */
export function SettledChips(props: {
  projects: readonly string[];
  value: string | null;
  onChange(project: string | null): void;
}) {
  const name = useProjectName();
  if (props.projects.length < 2 && props.value === null) return null;
  return (
    <div
      role="group"
      aria-label="Settled projects"
      className="flex shrink-0 flex-wrap gap-1.5 px-4 pb-2"
    >
      <button
        type="button"
        aria-pressed={props.value === null}
        onClick={() => props.onChange(null)}
        className={chip(props.value === null)}
      >
        All
      </button>
      {props.projects.map((id) => (
        <button
          key={id}
          type="button"
          aria-pressed={props.value === id}
          onClick={() => props.onChange(props.value === id ? null : id)}
          className={chip(props.value === id)}
        >
          <ProjectMark
            id={id}
            badge={projectBadge({ id, name: name(id) })}
            quiet={props.value !== id}
          />
          <span className="truncate">{name(id)}</span>
        </button>
      ))}
    </div>
  );
}

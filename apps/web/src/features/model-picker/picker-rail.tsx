import { StarIcon } from "@ace/icons";
import type { KeyboardEvent, ReactNode, Ref } from "react";
import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { part } from "@/lib/suit-part.ts";
import type { PickerEntry } from "@ace/ui-core";
import { railChoice } from "./picker-keys.ts";

const tabButton =
  "relative grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-accent/60 hover:text-foreground focus-ring-inset aria-selected:bg-accent aria-selected:text-foreground aria-disabled:opacity-40 pointer-coarse:size-8";

/** What a rail needs of an entry; a model picker or Spade's sources supply their own shape. */
export interface PickerRailEntry {
  id: string;
  name: string;
  reason?: string | undefined;
}

/**
 * Favorites, then one tab per source, with roving keyboard focus. A provider with several
 * accounts shows each as its own logo with the account's bubble on it, so they never read as
 * duplicates. An account that can't be used now (signed out, at its limit) keeps its tab, dimmed,
 * and opens on why. The caller draws each tab's mark, keeping its own provider and account rules.
 */
export function PickerRail<T extends PickerRailEntry>(props: {
  entries: readonly T[];
  selected: string;
  searching: boolean;
  listId: string;
  ref: Ref<HTMLDivElement>;
  focusList(): void;
  onSelect(id: string): void;
  renderMark(entry: T, selected: boolean): ReactNode;
}) {
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      props.focusList();
      return;
    }
    // From the focused tab, which a pointer or a programmatic focus may have moved off the selection.
    const focused =
      event.target instanceof HTMLElement
        ? event.target.closest("[data-tab]")?.getAttribute("data-tab")
        : null;
    const next = railChoice(props.entries, focused ?? props.selected, event.key);
    if (!next) return;
    event.preventDefault();
    props.onSelect(next.id);
    event.currentTarget.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  };
  if (!props.entries.length) return null;
  return (
    <div
      ref={props.ref}
      role="tablist"
      aria-label="Model sources"
      {...part("tabs", undefined, "model-sources")}
      aria-orientation="vertical"
      onKeyDown={onKey}
      className="flex min-h-0 w-10 shrink-0 flex-col items-center gap-1 overflow-x-hidden overflow-y-auto overscroll-contain border-r border-border py-1.5 scroll-quiet pointer-coarse:w-11"
    >
      {props.entries.map((entry) => {
        const selected = !props.searching && props.selected === entry.id;
        return (
          <Tip
            key={entry.id}
            label={[entry.name, entry.reason].filter(Boolean).join(" · ")}
            side="left"
          >
            <button
              type="button"
              role="tab"
              data-tab={entry.id}
              {...part("tab", selected ? "selected" : entry.reason ? "disabled" : undefined)}
              aria-label={entry.name}
              aria-selected={selected}
              aria-disabled={entry.reason ? true : undefined}
              aria-controls={`${props.listId}-pane`}
              tabIndex={props.selected === entry.id ? 0 : -1}
              onClick={() => props.onSelect(entry.id)}
              className={tabButton}
            >
              {props.renderMark(entry, selected)}
              {/* The selected tab's edge mark, against the list it shows. */}
              {selected && (
                <span
                  aria-hidden
                  className="absolute top-1.5 -right-1.5 bottom-1.5 w-0.5 rounded-full bg-ring"
                />
              )}
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

/** The shared rail's mark for ace's own model picker: a star, or the account's provider logo. */
export function ModelPickerRailMark(props: {
  entry: PickerEntry;
  selected: boolean;
}): ReactNode {
  if (props.entry.id === "favorites")
    return <StarIcon aria-hidden size={16} weight={props.selected ? "fill" : "regular"} />;
  if (!props.entry.provider) return null;
  return (
    <ProviderAccountIcon
      provider={props.entry.provider}
      instance={props.entry.instance}
      acpAgentId={props.entry.acpAgentId}
      size={16}
      tooltip={false}
      decorative
    />
  );
}

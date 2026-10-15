import { StarIcon } from "@phosphor-icons/react";
import type { KeyboardEvent, Ref } from "react";
import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import type { PickerEntry } from "./picker-entries.ts";

const tabButton =
  "relative grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-accent/60 hover:text-foreground focus-ring-inset aria-selected:bg-accent aria-selected:text-foreground aria-disabled:opacity-40 pointer-coarse:size-8";

/**
 * Favorites, then one tab per account, with roving keyboard focus. A provider with several
 * accounts shows each as its own logo with the account's bubble on it, so they never read as
 * duplicates. An account that can't be used now (signed out, at its limit) keeps its tab, dimmed,
 * and opens on why.
 */
export function PickerRail({
  ref,
  ...props
}: {
  entries: readonly PickerEntry[];
  selected: string;
  searching: boolean;
  listId: string;
  ref: Ref<HTMLDivElement>;
  focusList(): void;
  onSelect(id: string): void;
}) {
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      props.focusList();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = props.entries;
    // From the focused tab, which a pointer or a programmatic focus may have moved off the selection.
    const focused =
      event.target instanceof HTMLElement
        ? event.target.closest("[data-tab]")?.getAttribute("data-tab")
        : null;
    const at = tabs.findIndex((entry) => entry.id === (focused ?? props.selected));
    const next =
      tabs[
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (at + (event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length
      ];
    if (!next) return;
    props.onSelect(next.id);
    event.currentTarget.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  };
  if (!props.entries.length) return null;
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label="Model sources"
      aria-orientation="vertical"
      onKeyDown={onKey}
      className="flex min-h-0 w-10 shrink-0 flex-col items-center gap-1 overflow-x-hidden overflow-y-auto overscroll-contain border-r border-border py-1.5 [scrollbar-width:none] pointer-coarse:w-11 [&::-webkit-scrollbar]:hidden"
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
              aria-label={entry.name}
              aria-selected={selected}
              aria-disabled={entry.reason ? true : undefined}
              aria-controls={`${props.listId}-pane`}
              tabIndex={props.selected === entry.id ? 0 : -1}
              onClick={() => props.onSelect(entry.id)}
              className={tabButton}
            >
              {entry.id === "favorites" ? (
                <StarIcon aria-hidden size={16} weight={selected ? "fill" : "regular"} />
              ) : (
                entry.provider && (
                  <ProviderAccountIcon
                    provider={entry.provider}
                    instance={entry.instance}
                    acpAgentId={entry.acpAgentId}
                    size={16}
                    tooltip={false}
                    decorative
                  />
                )
              )}
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

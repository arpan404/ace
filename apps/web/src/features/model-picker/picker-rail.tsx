import { StarIcon } from "@phosphor-icons/react";
import type { KeyboardEvent, Ref } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useAccountViews } from "@/lib/account-views.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
import type { PickerEntry, RailGroup } from "./picker-entries.ts";

const tabButton =
  "grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-accent/60 hover:text-foreground focus-ring-inset aria-selected:bg-accent aria-selected:text-foreground data-disabled:opacity-40 pointer-coarse:size-8";

/** Favorites and one tab per provider, with roving keyboard focus. */
export function PickerRail({
  ref,
  ...props
}: {
  groups: readonly RailGroup[];
  selected: string;
  searching: boolean;
  listId: string;
  ref: Ref<HTMLDivElement>;
  focusList(): void;
  onSelect(id: string): void;
}) {
  const accounts = useAccountViews();
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      props.focusList();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const usable = props.groups.filter((group) => !group.reason);
    const at = usable.findIndex((group) => group.id === props.selected);
    const next =
      usable[
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? usable.length - 1
            : (at + (event.key === "ArrowDown" ? 1 : -1) + usable.length) % usable.length
      ];
    if (!next) return;
    props.onSelect(next.id);
    event.currentTarget.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  };
  if (!props.groups.length) return null;
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label="Model sources"
      aria-orientation="vertical"
      onKeyDown={onKey}
      className="flex min-h-0 w-9 shrink-0 flex-col items-center gap-0.5 overflow-x-hidden overflow-y-auto overscroll-contain border-r border-border py-1 [scrollbar-width:none] pointer-coarse:w-10 [&::-webkit-scrollbar]:hidden"
    >
      {props.groups.map((group) => {
        const activeTab = !props.searching && props.selected === group.id;
        const first: PickerEntry | undefined = group.accounts[0];
        const account = accounts.data?.find((candidate) => candidate.id === first?.instance);
        return (
          <Tip
            key={group.id}
            label={[group.name, group.reason].filter(Boolean).join(" · ")}
            side="left"
          >
            <button
              type="button"
              role="tab"
              data-tab={group.id}
              aria-label={group.name}
              aria-selected={activeTab}
              aria-disabled={group.reason ? true : undefined}
              data-disabled={group.reason ? "" : undefined}
              aria-controls={`${props.listId}-pane`}
              tabIndex={props.selected === group.id ? 0 : -1}
              onClick={() => {
                if (!group.reason) props.onSelect(group.id);
              }}
              className={tabButton}
            >
              {group.id === "favorites" ? (
                <StarIcon aria-hidden size={16} weight={activeTab ? "fill" : "regular"} />
              ) : (
                group.provider && (
                  <ProviderIcon
                    provider={group.provider}
                    acpAgentId={account?.acpAgentId}
                    size={16}
                    decorative
                  />
                )
              )}
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

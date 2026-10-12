import type { ProviderKind } from "@ace/protocol";
import { StarIcon } from "@phosphor-icons/react";
import type { KeyboardEvent, Ref } from "react";
import { accountBadge } from "@/components/ui/account-badge.ts";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useAccountViews } from "@/lib/account-views.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
import type { PickerEntry } from "./picker-entries.ts";

const tabButton =
  "relative grid size-9 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors duration-(--motion-fast) motion-reduce:transition-none hover:bg-accent hover:text-foreground focus-ring-inset aria-selected:text-foreground data-disabled:opacity-40 after:absolute after:-right-1 after:h-5 after:w-0.5 after:rounded-full aria-selected:after:bg-ring";

/** One tab per provider account, with roving keyboard focus. */
export function PickerRail({
  ref,
  ...props
}: {
  entries: readonly PickerEntry[];
  selected: string;
  searching: boolean;
  provider: ProviderKind | undefined;
  only: boolean;
  listId: string;
  ref: Ref<HTMLDivElement>;
  focusList(): void;
  onSelect(id: string): void;
  onClose?: (() => void) | undefined;
}) {
  const accounts = useAccountViews();
  const railEntries = props.entries;
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      props.focusList();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const usable = railEntries.filter((entry) => !entry.reason);
    const at = usable.findIndex((entry) => entry.id === props.selected);
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
  return (
    <>
      {props.entries.length > 0 && (
        <div
          ref={ref}
          role="tablist"
          aria-label="Model sources"
          aria-orientation="vertical"
          onKeyDown={onKey}
          className="flex min-h-0 w-11 shrink-0 flex-col items-center gap-1 overflow-x-hidden overflow-y-auto overscroll-contain border-r border-border px-1 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {railEntries.map((entry) => {
            const name = entry.name;
            const activeTab = !props.searching && props.selected === entry.id;
            const account = accounts.data?.find((candidate) => candidate.id === entry.instance);
            const multiple =
              railEntries.filter((candidate) => candidate.provider === entry.provider).length > 1;
            return (
              <Tip
                key={entry.id}
                label={[name, entry.reason].filter(Boolean).join(" · ")}
                side="left"
              >
                <button
                  type="button"
                  role="tab"
                  data-tab={entry.id}
                  aria-label={name}
                  aria-selected={activeTab}
                  aria-disabled={entry.reason ? true : undefined}
                  data-disabled={entry.reason ? "" : undefined}
                  aria-controls={`${props.listId}-pane`}
                  tabIndex={props.selected === entry.id ? 0 : -1}
                  onClick={() => {
                    if (!entry.reason) props.onSelect(entry.id);
                  }}
                  className={tabButton}
                >
                  {entry.id === "favorites" ? (
                    <StarIcon aria-hidden size={22} weight={activeTab ? "fill" : "regular"} />
                  ) : (
                    entry.provider && (
                      <span className="relative inline-flex">
                        <ProviderIcon
                          provider={entry.provider}
                          acpAgentId={account?.acpAgentId}
                          size={20}
                          decorative
                        />
                        {account && multiple && (
                          <span
                            role="img"
                            aria-label={`${account.label} account`}
                            className="absolute -right-1.5 -bottom-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-muted px-0.5 text-2xs font-medium text-muted-foreground"
                          >
                            {accountBadge(account.label, account.shortLabel)}
                          </span>
                        )}
                      </span>
                    )
                  )}
                </button>
              </Tip>
            );
          })}
        </div>
      )}
    </>
  );
}

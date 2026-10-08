import type { ProviderKind } from "@ace/protocol";
import { PlusIcon, StarIcon } from "@phosphor-icons/react";
import type { KeyboardEvent, Ref } from "react";
import { canAddAccounts, useAddAccount } from "@/features/account-management/index.ts";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import type { PickerEntry } from "./picker-entries.ts";

const tabButton =
  "grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-selected:bg-foreground/8 aria-selected:text-foreground data-disabled:opacity-40";

/** Account marks with a roving keyboard selection; the right pane owns model navigation. */
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
  const addAccount = useAddAccount();
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      props.focusList();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const usable = props.entries.filter((entry) => !entry.reason);
    const at = usable.findIndex((entry) => entry.id === props.selected);
    const next =
      usable[(at + (event.key === "ArrowDown" ? 1 : -1) + usable.length) % usable.length];
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
          className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border py-2"
        >
          {props.entries.map((entry) => {
            const name = entry.name;
            const activeTab = !props.searching && props.selected === entry.id;
            return (
              <Tip key={entry.id} label={entry.reason ?? name} side="left">
                <button
                  type="button"
                  role="tab"
                  data-tab={entry.id}
                  aria-label={name}
                  aria-selected={activeTab}
                  aria-disabled={entry.reason ? true : undefined}
                  data-disabled={entry.reason ? "" : undefined}
                  aria-controls={props.listId}
                  tabIndex={props.selected === entry.id ? 0 : -1}
                  onClick={() => {
                    if (!entry.reason) props.onSelect(entry.id);
                  }}
                  className={tabButton}
                >
                  {entry.id === "favorites" ? (
                    <StarIcon aria-hidden size={16} weight={activeTab ? "fill" : "regular"} />
                  ) : (
                    entry.provider && (
                      <ProviderAccountIcon
                        provider={entry.provider}
                        instance={entry.instance}
                        size={20}
                      />
                    )
                  )}
                </button>
              </Tip>
            );
          })}
          {!props.only && props.provider && canAddAccounts(props.provider) && addAccount && (
            <IconButton
              icon={PlusIcon}
              label="Add account…"
              size="sm"
              onClick={() => {
                props.onClose?.();
                if (props.provider) addAccount(props.provider);
              }}
            />
          )}
        </div>
      )}
    </>
  );
}

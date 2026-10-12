import type { KeyboardEvent } from "react";
import { Tip } from "@/components/ui/tooltip.tsx";
import type { PickerEntry } from "./picker-entries.ts";

/**
 * A provider's accounts, in the list's header: "Personal · Work · Team", the selected one with
 * a subtle fill. ← and → move between them; a limited or signed-out account says why.
 */
export function AccountSwitch(props: {
  accounts: readonly PickerEntry[];
  selected: string;
  listId: string;
  onSelect(id: string): void;
}) {
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const usable = props.accounts.filter((entry) => !entry.reason);
    const at = usable.findIndex((entry) => entry.id === props.selected);
    const next =
      usable[(at + (event.key === "ArrowRight" ? 1 : -1) + usable.length) % usable.length];
    if (!next) return;
    props.onSelect(next.id);
    event.currentTarget.querySelector<HTMLElement>(`[data-account="${next.id}"]`)?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label="Accounts"
      onKeyDown={onKey}
      className="mx-2 flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {props.accounts.map((entry) => {
        const selected = entry.id === props.selected;
        // "Claude Code · Personal" reads "Personal" here; the rail already names the provider.
        const label = entry.name.split(" · ").slice(1).join(" · ") || entry.name;
        return (
          <Tip key={entry.id} label={[entry.name, entry.reason].filter(Boolean).join(" · ")}>
            <button
              type="button"
              role="tab"
              data-account={entry.id}
              aria-label={entry.name}
              aria-selected={selected}
              aria-disabled={entry.reason ? true : undefined}
              aria-controls={`${props.listId}-pane`}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                if (!entry.reason) props.onSelect(entry.id);
              }}
              className="h-6 shrink-0 rounded-sm px-2 text-xs text-muted-foreground transition-colors duration-(--motion-fast) hover:text-foreground focus-ring-inset aria-disabled:opacity-40 aria-selected:bg-accent aria-selected:text-foreground pointer-coarse:h-8"
            >
              {label}
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

import { ArrowRightIcon, ChatCircleIcon, PaletteIcon, PlusIcon } from "@phosphor-icons/react";
import { useCallback } from "react";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command.tsx";
import { formatKeys } from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";
import { usePaletteGroups, type PaletteCommand, type PaletteGroup } from "./commands.ts";

const label = (item: PaletteCommand) => `${item.label} ${item.detail ?? ""}`;
const icons = {
  thread: ChatCircleIcon,
  view: ArrowRightIcon,
  action: PlusIcon,
  theme: PaletteIcon,
} as const;

/** ⌘K. Focus moves to the search field on open and returns to the opener on close. */
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useLayout();
  const close = useCallback(() => setPaletteOpen(false), [setPaletteOpen]);
  const groups = usePaletteGroups(close);
  return (
    <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
      {paletteOpen && (
        <Command items={groups} itemToStringValue={label}>
          <CommandInput
            aria-label="Search commands"
            placeholder="Search threads, jump to a view, run a command…"
          />
          <CommandEmpty>No matches. Try a thread title or a view name.</CommandEmpty>
          <CommandList>
            {(group: PaletteGroup) => (
              <CommandGroup key={group.value} items={group.items}>
                <CommandGroupLabel>{group.value}</CommandGroupLabel>
                <CommandCollection>
                  {(item: PaletteCommand) => {
                    const Glyph = icons[item.icon];
                    return (
                      <CommandItem key={item.id} value={item} onClick={item.run}>
                        <Glyph aria-hidden size={16} />
                        <span className="min-w-0 truncate">{item.label}</span>
                        {item.detail && (
                          <span className="ml-1 shrink-0 text-[12px] text-subtle-foreground">
                            {item.detail}
                          </span>
                        )}
                        {item.keys && <CommandShortcut>{formatKeys(item.keys)}</CommandShortcut>}
                      </CommandItem>
                    );
                  }}
                </CommandCollection>
              </CommandGroup>
            )}
          </CommandList>
          <CommandFooter />
        </Command>
      )}
    </CommandDialog>
  );
}

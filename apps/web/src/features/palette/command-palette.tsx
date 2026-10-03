import { useCallback } from "react";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { usePaletteGroups, type PaletteCommand, type PaletteGroup } from "./commands.ts";

const label = (item: PaletteCommand) => item.label;

/** ⌘K. Focus moves to the search field on open and returns to the opener on close. */
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useLayout();
  const close = useCallback(() => setPaletteOpen(false), [setPaletteOpen]);
  const groups = usePaletteGroups(close);
  return (
    <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
      {paletteOpen && (
        <Command items={groups} itemToStringValue={label}>
          <CommandInput aria-label="Search commands" placeholder="Search threads and commands…" />
          <CommandEmpty />
          <CommandList>
            {(group: PaletteGroup) => (
              <CommandGroup key={group.value} items={group.items}>
                <CommandGroupLabel>{group.value}</CommandGroupLabel>
                <CommandCollection>
                  {(item: PaletteCommand) => (
                    <CommandItem key={item.id} value={item} onClick={item.run}>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.hint && <CommandShortcut>{item.hint}</CommandShortcut>}
                    </CommandItem>
                  )}
                </CommandCollection>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      )}
    </CommandDialog>
  );
}

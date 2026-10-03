import {
  ArrowRightIcon,
  ChatCircleIcon,
  CheckIcon,
  FolderSimpleIcon,
  PaletteIcon,
  PlusIcon,
} from "@phosphor-icons/react";
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

// Label, detail and branch are all searched, so a branch or project name finds its thread.
const label = (item: PaletteCommand) => `${item.label} ${item.detail ?? ""} ${item.more ?? ""}`;
const icons = {
  thread: ChatCircleIcon,
  project: FolderSimpleIcon,
  view: ArrowRightIcon,
  action: PlusIcon,
  settle: CheckIcon,
  theme: PaletteIcon,
} as const;

/** ⌘K. Focus moves to the search field on open and returns to the opener on close. */
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useLayout();
  const close = useCallback(() => setPaletteOpen(false), [setPaletteOpen]);
  return (
    <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
      {paletteOpen && <PaletteBody close={close} />}
    </CommandDialog>
  );
}

/** Mounted only while open, so its list subscriptions end when the palette closes. */
function PaletteBody(props: { close(): void }) {
  const groups = usePaletteGroups(props.close);
  return (
    <Command items={groups} itemToStringValue={label}>
      <CommandInput
        aria-label="Search commands"
        placeholder="Search threads, jump to a view, run a command…"
      />
      <CommandEmpty>No matches. Try a thread title, a project or a branch.</CommandEmpty>
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
                      <span className="ml-1 min-w-0 shrink truncate text-[12px] text-subtle-foreground">
                        {item.detail}
                        {item.more && (
                          <span className="hidden in-data-highlighted:inline"> · {item.more}</span>
                        )}
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
  );
}

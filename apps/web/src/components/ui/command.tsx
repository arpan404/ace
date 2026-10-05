import * as React from "react";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog } from "@base-ui/react/dialog";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { Kbd } from "./kbd.tsx";
import { layers, menuLabel } from "./menu-styles.ts";

/**
 * ⌘K shell on Base UI (Dialog + inline Autocomplete), replacing the registry's cmdk-based
 * `command`, which depends on Radix. 620px glass sheet at 18% from the top (near the top on a
 * phone, where the keyboard takes the bottom half).
 */
function CommandDialog({
  open,
  onOpenChange,
  title = "Command palette",
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            layers.overlay,
            "fixed inset-0 bg-black/25 transition-opacity duration-(--dur-2) [-webkit-app-region:no-drag] data-ending-style:opacity-0 data-starting-style:opacity-0",
          )}
        />
        <Dialog.Popup
          aria-label={title}
          className={cn(
            layers.modal,
            "glass fixed top-[18%] left-1/2 flex max-h-[min(540px,70dvh)] w-[min(620px,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl text-popover-foreground outline-none [-webkit-app-region:no-drag] max-sm:top-3",
            "transition-[opacity,transform] duration-(--dur-2) ease-spring data-ending-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:duration-(--dur-exit) data-ending-style:ease-exit data-starting-style:-translate-y-1.5 data-starting-style:scale-[0.98] data-starting-style:opacity-0",
          )}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The palette's list. Pass `filter={null}` with items already ranked to take over matching;
 * `value` and `onValueChange` hold the query.
 */
function Command<Item>(props: {
  items: { value: string; items: Item[] }[];
  itemToStringValue(item: Item): string;
  filter?: null;
  value?: string;
  onValueChange?(value: string): void;
  children: React.ReactNode;
}) {
  return (
    <Autocomplete.Root
      open
      inline
      items={props.items}
      itemToStringValue={props.itemToStringValue}
      autoHighlight="always"
      keepHighlight
      {...(props.filter === null ? { filter: null } : {})}
      {...(props.value === undefined ? {} : { value: props.value })}
      // Picking an item runs it; it never becomes the query.
      {...(props.onValueChange
        ? {
            onValueChange: (value: string, details: { reason: string }) => {
              if (details.reason !== "item-press") props.onValueChange?.(value);
            },
          }
        : {})}
    >
      {props.children}
    </Autocomplete.Root>
  );
}

/**
 * The search field. Its esc chip is the close control (so Tab lands on something visible); on
 * touch, where there's no Esc key, a "Close" button takes its place.
 */
function CommandInput({
  className,
  closeLabel = "Close command palette",
  ...props
}: Autocomplete.Input.Props & { closeLabel?: string }) {
  return (
    <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b px-4">
      <MagnifyingGlassIcon aria-hidden size={18} className="shrink-0 text-muted-foreground" />
      <Autocomplete.Input
        data-slot="command-input"
        className={cn(
          "h-full min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none placeholder:text-subtle-foreground",
          className,
        )}
        {...props}
      />
      <Dialog.Close
        aria-label={closeLabel}
        className="relative grid shrink-0 place-items-center rounded-sm text-sm font-medium text-muted-foreground focus-ring touch-hit touch-hit-lg"
      >
        {/* The chip hides itself on touch, where "Close" shows instead. */}
        <Kbd>esc</Kbd>
        <span aria-hidden className="hidden px-1 pointer-coarse:inline">
          Close
        </span>
      </Dialog.Close>
    </div>
  );
}

function CommandList({ className, ...props }: Autocomplete.List.Props) {
  return (
    <Autocomplete.List
      data-slot="command-list"
      className={cn("min-h-0 flex-1 scroll-py-2 overflow-y-auto p-2", className)}
      {...props}
    />
  );
}

function CommandEmpty({ children = "No matches." }: { children?: React.ReactNode }) {
  return (
    <Autocomplete.Empty>
      <div className="py-8 text-center text-ui text-muted-foreground">{children}</div>
    </Autocomplete.Empty>
  );
}

function CommandGroup({ className, ...props }: Autocomplete.Group.Props) {
  return (
    <Autocomplete.Group
      data-slot="command-group"
      className={cn("not-last:mb-1", className)}
      {...props}
    />
  );
}

function CommandGroupLabel({ className, ...props }: Autocomplete.GroupLabel.Props) {
  return <Autocomplete.GroupLabel className={cn(menuLabel, "pt-2", className)} {...props} />;
}

const CommandCollection = Autocomplete.Collection;

function CommandItem({ className, ...props }: Autocomplete.Item.Props) {
  return (
    <Autocomplete.Item
      data-slot="command-item"
      className={cn(
        "flex h-9 cursor-default items-center gap-[9px] rounded-md px-2.5 text-base text-foreground outline-none select-none data-disabled:opacity-50 data-highlighted:bg-accent pointer-coarse:h-11 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span className={cn("ml-auto shrink-0 text-xs text-muted-foreground", className)} {...props} />
  );
}

/** Key hints along the bottom edge. Hidden on touch, where there are no keys to press. */
function CommandFooter() {
  return (
    <div className="flex shrink-0 gap-3.5 border-t px-3.5 py-2 text-xs text-muted-foreground pointer-coarse:hidden">
      <span className="inline-flex items-center gap-1.5">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd>
        navigate
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Kbd>↵</Kbd>
        select
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Kbd shortcut="palette" />
        toggle
      </span>
    </div>
  );
}

export {
  CommandDialog,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandCollection,
  CommandItem,
  CommandShortcut,
  CommandFooter,
};

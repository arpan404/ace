import * as React from "react";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog } from "@base-ui/react/dialog";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { DialogOverlay } from "./dialog.tsx";
import { Kbd } from "./kbd.tsx";
import { layers, menuLabel, overlaySurface } from "./menu-styles.ts";

/**
 * ⌘K shell on Base UI (Dialog + inline Autocomplete), replacing the registry's cmdk-based
 * `command`, which depends on Radix. 620px solid sheet at 18% from the top (near the top on a
 * phone, where the keyboard takes the bottom half).
 */
function CommandDialog({
  open,
  onOpenChange,
  title = "Command palette",
  className,
  overlayClassName,
  overlayStyle,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title?: string;
  className?: string;
  overlayClassName?: string;
  overlayStyle?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogOverlay className={overlayClassName} style={overlayStyle} />
        <Dialog.Popup
          aria-label={title}
          className={cn(
            layers.modal,
            overlaySurface,
            "fixed top-[18%] left-1/2 flex min-h-[min(360px,70dvh)] max-h-[min(540px,70dvh)] w-[min(620px,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-lg text-popover-foreground outline-none [-webkit-app-region:no-drag] max-sm:top-3",
            "transition-[opacity,transform] duration-(--dur-2) ease-spring data-ending-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:duration-(--dur-exit) data-ending-style:ease-exit data-starting-style:-translate-y-1.5 data-starting-style:scale-[0.98] data-starting-style:opacity-0",
            className,
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
 * The sheet's top row: a magnifier, the field (`commandField`), anything beside it (a spinner)
 * and the esc chip, which is the close control (so Tab lands on something visible). On touch,
 * where there's no Esc key, a "Close" button takes the chip's place. The field is always focused
 * while the sheet is open, so the caret is its focus mark.
 */
const commandField =
  "h-full min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none placeholder:text-subtle-foreground";
function CommandSearchRow(props: { closeLabel: string; children: React.ReactNode }) {
  return (
    <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b px-4">
      <MagnifyingGlassIcon aria-hidden size={18} className="shrink-0 text-muted-foreground" />
      {props.children}
      <Dialog.Close
        aria-label={props.closeLabel}
        className="focus-ring relative grid shrink-0 place-items-center rounded-sm text-sm font-medium text-muted-foreground touch-hit touch-hit-lg"
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

/** The palette's search field, in the sheet's top row. */
function CommandInput({
  className,
  closeLabel = "Close command palette",
  ...props
}: Autocomplete.Input.Props & { closeLabel?: string }) {
  return (
    <CommandSearchRow closeLabel={closeLabel}>
      <Autocomplete.Input
        data-slot="command-input"
        className={cn(commandField, className)}
        {...props}
      />
    </CommandSearchRow>
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
        "flex h-9 cursor-default items-center gap-[9px] rounded-md px-2.5 text-ui text-foreground outline-none select-none data-disabled:opacity-50 data-highlighted:bg-accent pointer-coarse:h-11 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
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
  return null;
}

export {
  CommandDialog,
  Command,
  commandField,
  CommandInput,
  CommandSearchRow,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandCollection,
  CommandItem,
  CommandShortcut,
  CommandFooter,
};

import * as React from "react";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog } from "@base-ui/react/dialog";
import { cn } from "cn";
import { SearchIcon } from "lucide-react";

/**
 * shadcn-style command palette on Base UI (Dialog + inline Autocomplete), replacing the
 * registry's cmdk-based `command`, which depends on Radix.
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
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/20 data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0" />
        <Dialog.Popup
          aria-label={title}
          className="fixed top-[15vh] left-1/2 z-50 flex max-h-[min(32rem,70dvh)] w-[calc(100vw-1rem)] max-w-lg -translate-x-1/2 flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none"
        >
          {children}
          <Dialog.Close className="sr-only">Close {title}</Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Command<Item>(props: {
  items: { value: string; items: Item[] }[];
  itemToStringValue(item: Item): string;
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
    >
      {props.children}
    </Autocomplete.Root>
  );
}

function CommandInput({ className, ...props }: Autocomplete.Input.Props) {
  return (
    <div className="flex items-center gap-2 border-b px-3">
      <SearchIcon aria-hidden="true" className="size-4 shrink-0 opacity-50" />
      <Autocomplete.Input
        data-slot="command-input"
        className={cn(
          "h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: Autocomplete.List.Props) {
  return (
    <Autocomplete.List
      data-slot="command-list"
      className={cn("min-h-0 flex-1 scroll-py-1 overflow-y-auto p-1", className)}
      {...props}
    />
  );
}

function CommandEmpty({ children = "No results found." }: { children?: React.ReactNode }) {
  return (
    <Autocomplete.Empty>
      <div className="py-6 text-center text-sm text-muted-foreground">{children}</div>
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
  return (
    <Autocomplete.GroupLabel
      className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

const CommandCollection = Autocomplete.Collection;

function CommandItem({ className, ...props }: Autocomplete.Item.Props) {
  return (
    <Autocomplete.Item
      data-slot="command-item"
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-muted data-highlighted:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("ml-auto text-xs tracking-widest text-muted-foreground", className)}
      {...props}
    />
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
};

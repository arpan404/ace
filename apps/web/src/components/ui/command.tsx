import * as React from "react";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog } from "@base-ui/react/dialog";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { Kbd } from "./kbd.tsx";
import { menuLabel } from "./menu-styles.ts";

/**
 * ⌘K shell on Base UI (Dialog + inline Autocomplete), replacing the registry's cmdk-based
 * `command`, which depends on Radix. 620px glass sheet at 18% from the top.
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
        <Dialog.Backdrop className="fixed inset-0 z-[100] bg-black/25 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          aria-label={title}
          className={cn(
            "glass fixed top-[18%] left-1/2 z-[101] flex max-h-[min(540px,70dvh)] w-[min(620px,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl text-popover-foreground outline-none",
            "transition-[opacity,transform] duration-200 ease-spring data-ending-style:opacity-0 data-starting-style:-translate-y-1.5 data-starting-style:scale-[0.98] data-starting-style:opacity-0",
          )}
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
      <Kbd>esc</Kbd>
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
      <div className="py-8 text-center text-ui text-subtle-foreground">{children}</div>
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
        "flex h-9 cursor-default items-center gap-[9px] rounded-md px-2.5 text-[13.5px] text-foreground outline-none select-none data-highlighted:bg-accent [&_svg]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("ml-auto text-xs text-subtle-foreground", className)} {...props} />;
}

/** Key hints along the bottom edge. */
function CommandFooter() {
  return (
    <div className="flex shrink-0 gap-3.5 border-t px-3.5 py-2 text-xs text-subtle-foreground">
      <span className="inline-flex items-center gap-1.5">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd>
        navigate
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Kbd>↵</Kbd>
        open
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Kbd keys="mod+k" />
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

import { DotsThreeIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";

/**
 * The folded header's ⋯: the actions in a row, then the title menu behind one more tap. Loaded
 * when a header first folds (`AppHeader`), so a wide window never fetches the popover.
 */
export function Overflow(props: {
  actions: ReactNode;
  menu: ReactNode;
  label: string;
  /** The ⋯ was pressed while this code loaded: open at once. */
  defaultOpen: boolean;
}) {
  return (
    <Popover defaultOpen={props.defaultOpen}>
      <PopoverTrigger render={<IconButton icon={DotsThreeIcon} label={props.label} />} />
      <PopoverContent
        align="end"
        className="flex max-w-[calc(100vw-1.5rem)] flex-col gap-1.5 p-1.5"
      >
        {props.actions && (
          <div className="flex flex-wrap items-center gap-1.5">{props.actions}</div>
        )}
        {props.actions && props.menu && <span aria-hidden className="-mx-1.5 h-px bg-border" />}
        {props.menu && (
          <Menu>
            <MenuTrigger className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent aria-expanded:bg-accent">
              <DotsThreeIcon aria-hidden size={16} />
              More options
            </MenuTrigger>
            <MenuContent align="end">{props.menu}</MenuContent>
          </Menu>
        )}
      </PopoverContent>
    </Popover>
  );
}

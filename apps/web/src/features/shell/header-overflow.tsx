import { DotsThreeIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";

const row = "flex flex-wrap items-center gap-1.5";
const rule = "-mx-1.5 h-px bg-border";

/**
 * The folded header's ⋯: the actions in a row, the header's tools (on a phone: search, summary,
 * the panels and their count) in another, then the title menu behind one more tap. Loaded when
 * a header first folds (`AppHeader`), so a wide window never fetches the popover. With tools it
 * stays mounted while closed, so their shortcuts keep working.
 */
export function Overflow(props: {
  actions: ReactNode;
  tools?: ReactNode;
  menu: ReactNode;
  label: string;
  /** The ⋯ was pressed while this code loaded: open at once. */
  defaultOpen: boolean;
}) {
  // Held here: an uncontrolled popover mounted with `defaultOpen` stayed closed after a press on
  // the placeholder ⋯ (the case `defaultOpen` exists for).
  const [open, setOpen] = useState(props.defaultOpen);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<IconButton icon={DotsThreeIcon} label={props.label} />} />
      <PopoverContent
        align="end"
        keepMounted={!!props.tools}
        className="flex max-w-[calc(100vw-1.5rem)] flex-col gap-1.5 p-1.5"
      >
        {props.actions && <div className={row}>{props.actions}</div>}
        {props.actions && props.tools && <span aria-hidden className={rule} />}
        {props.tools && (
          <div
            className={row}
            // A panel toggle opens a panel over the header (a sheet on a phone): the ⋯ steps
            // aside instead of staying open under it, where Escape would close it first.
            onClick={(event) => {
              if ((event.target as Element).closest("[data-dock-toggle]")) setOpen(false);
            }}
          >
            {props.tools}
          </div>
        )}
        {(props.actions || props.tools) && props.menu && <span aria-hidden className={rule} />}
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
